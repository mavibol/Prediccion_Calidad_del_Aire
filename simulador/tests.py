"""
Pruebas de la app. Son autosuficientes: entrenan modelos pequeños de
scikit-learn en una carpeta temporal, así que no dependen de los .joblib reales.

    python manage.py test simulador
"""
import json
import shutil
import tempfile
from pathlib import Path

import joblib
from django.conf import settings
from django.test import Client, TestCase, override_settings
from sklearn.ensemble import GradientBoostingRegressor
from xgboost import XGBRegressor

from .ml import catalogo as cat
from .ml.datos import cargar_y_limpiar, columnas_escenario_a, construir_features, particion_cronologica
from .ml_service import ServicioML, nivel_ica, nombre_canonico, reiniciar_servicio

URL_PREDECIR = "/api/predecir/"


class BaseConModelos(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tmp = Path(tempfile.mkdtemp())
        mat = construir_features(cargar_y_limpiar(settings.AIRE_RUTA_CSV))
        tr, _, _ = particion_cronologica(mat)
        X = tr[columnas_escenario_a()]
        for clave, conf in cat.OBJETIVOS.items():
            m = GradientBoostingRegressor(n_estimators=25, max_depth=3, random_state=0)
            joblib.dump(m.fit(X, tr[f"y_{clave}"]), cls.tmp / conf["archivo"])
        cls._ajustes = override_settings(AIRE_DIR_MODELOS=cls.tmp)
        cls._ajustes.enable()
        reiniciar_servicio()

    @classmethod
    def tearDownClass(cls):
        cls._ajustes.disable()
        reiniciar_servicio()
        shutil.rmtree(cls.tmp, ignore_errors=True)
        super().tearDownClass()

    def predecir(self, variables, client=None):
        c = client or self.client
        return c.post(URL_PREDECIR, data=json.dumps({"variables": variables}),
                      content_type="application/json")


class ModelosNativosXGBoostTests(TestCase):
    def test_carga_json_nativo_preferido_sobre_joblib(self):
        mat = construir_features(cargar_y_limpiar(settings.AIRE_RUTA_CSV))
        tr, _, _ = particion_cronologica(mat)
        columnas = columnas_escenario_a()

        with tempfile.TemporaryDirectory() as temp:
            carpeta = Path(temp)
            for clave, conf in cat.OBJETIVOS.items():
                modelo = XGBRegressor(n_estimators=5, max_depth=2, n_jobs=1, random_state=0)
                modelo.fit(tr[columnas], tr[f"y_{clave}"])
                modelo.save_model(carpeta / conf["archivo"].replace(".joblib", ".json"))
                joblib.dump("archivo joblib ignorado", carpeta / conf["archivo"])

            servicio = ServicioML(carpeta, settings.AIRE_RUTA_CSV)

        self.assertTrue(servicio.listo, servicio.error_carga)
        self.assertEqual(
            {objetivo.archivo for objetivo in servicio.objetivos.values()},
            {"modelo_pm2_5_XGBoost.json", "modelo_pm10_XGBoost.json"},
        )


class PaginaYCatalogoTests(BaseConModelos):
    def test_inicio_renderiza_constructor_y_catalogo(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, 'id="catalogo-variables"')
        self.assertContains(r, 'id="lista-variables"')
        self.assertContains(r, "csrf-token")
        self.assertContains(r, "Atribución calculada mediante")
        self.assertContains(r, "SHapley Additive exPlanations")
        self.assertContains(r, "E[f(X)]")
        self.assertContains(r, 'id="ficha-modelo"')
        self.assertContains(r, 'id="grafico-cascada"')
        self.assertContains(r, "Modo técnico")

    def test_catalogo_solo_variables_del_dataset(self):
        datos = self.client.get("/api/variables/").json()
        ids = {v["id"] for v in datos["variables"]}
        self.assertEqual(ids, set(cat.VARIABLES))
        self.assertNotIn("us_aqi", ids)
        self.assertNotIn("european_aqi", ids)
        por_id = {v["id"]: v for v in datos["variables"]}
        self.assertEqual(por_id["pm10"]["etiqueta"], "PM₁₀")
        self.assertEqual(por_id["pm10"]["nombre_largo"], "Material particulado grueso")
        self.assertEqual(por_id["pm10"]["unidad"], "µg/m³")
        self.assertEqual(por_id["pm2_5"]["etiqueta"], "PM₂.₅")
        self.assertEqual(por_id["pm2_5"]["nombre_largo"], "Material particulado fino")
        self.assertEqual(por_id["nitrogen_dioxide"]["nombre_largo"], "Dióxido de nitrógeno")
        self.assertEqual(por_id["nitrogen_dioxide"]["unidad"], "µg/m³")
        self.assertNotIn("temperature", ids)
        self.assertNotIn("relative_humidity", ids)
        self.assertNotIn("wind_speed", ids)


class PrediccionTests(BaseConModelos):
    def test_subconjunto_de_variables_y_shap_aditivo(self):
        r = self.predecir([{"variable": "pm2_5", "valor": "21,5"},
                           {"variable": "nitrogen_dioxide", "valor": 18}])
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(len(d["entrada"]["ingresadas"]), 2)
        self.assertEqual(len(d["entrada"]["estimadas"]), 7)
        self.assertEqual(d["entrada"]["completitud"], {
            "ingresadas": 2, "total": len(cat.VARIABLES), "porcentaje": 22.2,
        })
        self.assertEqual(d["tecnico"]["imputacion"], "iterativa")
        for clave in ("pm2_5", "pm10"):
            self.assertTrue(d["explicacion"][clave]["verificacion_aditiva"]["ok"])
            self.assertEqual(len(d["explicacion"][clave]["detalle"]), 21)
            pred = d["predicciones"][clave]
            intervalo = pred["intervalo_p95"]
            self.assertLessEqual(intervalo["inferior"], pred["valor"])
            self.assertGreaterEqual(intervalo["superior"], pred["valor"])
            self.assertGreater(pred["margen_p95"], 0)
            self.assertIn("validación cronológico", intervalo["referencia"])
            self.assertGreater(pred["rmse_prueba"], 0)
        self.assertEqual(len(d["recomendaciones"]), len(cat.ACTIVIDADES))
        self.assertIn(d["alerta"]["nivel"], [n["id"] for n in cat.NIVELES])

    def test_explicacion_para_publico_general(self):
        d = self.predecir([{"variable": "pm2_5", "valor": 30}]).json()
        a = d["alerta"]
        for k in ("cara", "titulo", "frase"):
            self.assertTrue(a[k])
        s = d["explicacion"][a["contaminante"]]["simple"]
        self.assertTrue(s["frase"].startswith("El valor predicho"))
        self.assertLessEqual(len(s["desfavorables"]), 3)
        self.assertLessEqual(len(s["favorables"]), 3)
        self.assertAlmostEqual(s["valor_base"], d["explicacion"][a["contaminante"]]["valor_base"], places=3)
        self.assertAlmostEqual(s["prediccion"], d["explicacion"][a["contaminante"]]["prediccion"], places=3)
        self.assertTrue(all(f["aporte"] >= 0 for f in s["desfavorables"]))
        self.assertTrue(all(f["aporte"] <= 0 for f in s["favorables"]))
        for f in s["desfavorables"] + s["favorables"]:
            self.assertIn("µg/m³", f["unidad"])
            self.assertIn("—", f["nombre"])
        self.assertIn(d["cobertura"]["puntos"], range(1, 6))
        self.assertTrue(all(len(r["corto"].split()) <= 6 for r in d["recomendaciones"]))

    def test_mas_variables_mas_cobertura(self):
        una = self.predecir([{"variable": "pm2_5", "valor": 15}]).json()
        todas = self.predecir([{"variable": v, "valor": cat_v, "valor_previo": cat_v}
                               for v, cat_v in [("pm2_5", 15), ("pm10", 20),
                                                ("carbon_monoxide", 400),
                                                ("nitrogen_dioxide", 14),
                                                ("sulphur_dioxide", 4), ("ozone", 55),
                                                ("aerosol_optical_depth", 0.24),
                                                ("dust", 0), ("uv_index", 1.8)]]).json()
        self.assertGreater(todas["cobertura"]["porcentaje"], una["cobertura"]["porcentaje"])
        self.assertAlmostEqual(todas["cobertura"]["porcentaje"], 100.0, places=0)
        self.assertEqual(todas["entrada"]["estimadas"], [])
        self.assertEqual(todas["entrada"]["completitud"]["ingresadas"], len(cat.VARIABLES))
        self.assertEqual(todas["entrada"]["completitud"]["porcentaje"], 100.0)

    def test_lectura_actual_extrema_eleva_el_semaforo(self):
        d = self.predecir([{"variable": "pm2_5", "valor": 80}]).json()
        self.assertEqual(d["alerta"]["nivel"], "alto")
        self.assertEqual(d["alerta"]["fuente"], "lectura_actual")
        self.assertTrue(d["avisos"])

    def test_acepta_valores_superiores_al_maximo_historico(self):
        r = self.predecir([{"variable": "pm10", "valor": 99999}])
        self.assertEqual(r.status_code, 200, r.json())
        datos = r.json()
        self.assertEqual(datos["entrada"]["ingresadas"][0]["valor"], 99999)
        self.assertTrue(any("menos confiable" in aviso for aviso in datos["avisos"]))

    def test_errores_de_validacion(self):
        casos = [
            [],
            [{"variable": "us_aqi", "valor": 50}],
            [{"variable": "pm10", "valor": "abc"}],
            [{"variable": "pm10", "valor": -3}],
            [{"variable": "pm10", "valor": 10}, {"variable": "pm10", "valor": 12}],
        ]
        for variables in casos:
            with self.subTest(variables=variables):
                r = self.predecir(variables)
                self.assertEqual(r.status_code, 400)
                self.assertFalse(r.json()["ok"])

    def test_metodo_y_formato(self):
        self.assertEqual(self.client.get(URL_PREDECIR).status_code, 405)
        r = self.client.post(URL_PREDECIR, data="pm2_5=10",
                             content_type="application/x-www-form-urlencoded")
        self.assertEqual(r.status_code, 415)
        r = self.client.post(URL_PREDECIR, data="{no json", content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_csrf_obligatorio(self):
        cliente = Client(enforce_csrf_checks=True)
        r = self.predecir([{"variable": "pm2_5", "valor": 10}], client=cliente)
        self.assertEqual(r.status_code, 403)

    def test_benchmark_incluye_resultados_tesis(self):
        d = self.client.get("/api/benchmark/").json()
        self.assertTrue(d["ok"])
        self.assertEqual(d["tesis"]["particion"]["entrenamiento"], 906)
        for clave in cat.OBJETIVOS:
            metricas = d["metricas_validacion"][clave]
            self.assertGreater(metricas["muestras"], 0)
            self.assertGreater(metricas["mae"], 0)
            self.assertGreater(metricas["rmse"], 0)
            self.assertIn("r2", metricas)

    def test_estado_expone_ficha_de_modelo_y_metricas(self):
        d = self.client.get("/api/estado/").json()
        self.assertTrue(d["ok"])
        self.assertEqual(set(d["modelos"]), set(cat.OBJETIVOS))
        for modelo in d["modelos"].values():
            self.assertTrue(modelo["tipo"])
            self.assertGreater(modelo["metricas_validacion"]["muestras"], 0)


class SinModelosTests(TestCase):
    def test_responde_503_si_faltan_modelos(self):
        vacia = Path(tempfile.mkdtemp())
        try:
            with override_settings(AIRE_DIR_MODELOS=vacia):
                reiniciar_servicio()
                self.assertEqual(self.client.get("/").status_code, 200)
                r = self.client.post(URL_PREDECIR, data=json.dumps({"pm2_5": 10}),
                                     content_type="application/json")
                self.assertEqual(r.status_code, 503)
        finally:
            reiniciar_servicio()
            shutil.rmtree(vacia, ignore_errors=True)


class UtilidadesTests(TestCase):
    def test_alias_de_columnas_de_colab(self):
        self.assertEqual(nombre_canonico("NO2_lag1"), "nitrogen_dioxide_lag1")
        self.assertEqual(nombre_canonico("pm25_ma3"), "pm2_5_ma3")
        self.assertEqual(nombre_canonico("month"), "mes")
        with self.assertRaises(ValueError):
            nombre_canonico("temperatura_lag1")

    def test_cortes_ica_resolucion_2254(self):
        self.assertEqual(nivel_ica("pm2_5", 12.4)["id"], "sin_contaminacion")
        self.assertEqual(nivel_ica("pm2_5", 12.6)["id"], "bajo")
        self.assertEqual(nivel_ica("pm2_5", 37)["id"], "bajo")
        self.assertEqual(nivel_ica("pm2_5", 38)["id"], "moderado")
        self.assertEqual(nivel_ica("pm2_5", 56)["id"], "alto")
        self.assertEqual(nivel_ica("pm2_5", 151)["id"], "critico")
        self.assertEqual(nivel_ica("pm10", 54)["id"], "sin_contaminacion")
        self.assertEqual(nivel_ica("pm10", 155)["id"], "moderado")
