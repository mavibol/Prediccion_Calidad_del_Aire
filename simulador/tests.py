"""
Pruebas de la app. Son autosuficientes: entrenan modelos LightGBM pequeños del
escenario C en una carpeta temporal, así que no dependen de los modelos reales.
No consultan Internet: usan el clima típico de cada mes (AIRE_METEO_EN_LINEA=False).

    python manage.py test simulador
"""
import json
import shutil
import tempfile
from pathlib import Path

from unittest import mock

import lightgbm as lgb
from django.conf import settings
from django.test import Client, TestCase, override_settings

from .ml import catalogo as cat
from .ml import meteo
from .ml.datos import (cargar_meteo, cargar_y_limpiar, columnas_escenario_c, construir_features,
                       particion_cronologica)
from .ml_service import ServicioML, nivel_ica, nombre_canonico, reiniciar_servicio, variable_de

URL_PREDECIR = "/api/predecir/"


class BaseConModelos(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tmp = Path(tempfile.mkdtemp())
        mat = construir_features(cargar_y_limpiar(settings.AIRE_RUTA_CSV), cargar_meteo(settings.AIRE_RUTA_METEO))
        tr, _, _ = particion_cronologica(mat)
        X = tr[columnas_escenario_c()]
        for clave, conf in cat.OBJETIVOS.items():
            m = lgb.LGBMRegressor(n_estimators=40, num_leaves=7, random_state=0, verbose=-1)
            m.fit(X, tr[f"y_{clave}"]).booster_.save_model(cls.tmp / conf["archivo"])
        cls._ajustes = override_settings(AIRE_DIR_MODELOS=cls.tmp, AIRE_METEO_EN_LINEA=False)
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


class EscenarioCTests(BaseConModelos):
    def test_carga_lightgbm_txt_con_51_variables(self):
        from .ml_service import obtener_servicio
        s = obtener_servicio()
        self.assertTrue(s.listo, s.error_carga)
        self.assertTrue(s.usa_meteo)
        for obj in s.objetivos.values():
            self.assertEqual(len(obj.columnas), 51)
            self.assertTrue(obj.archivo.endswith(".txt"))

    def test_sin_internet_usa_clima_tipico_del_mes(self):
        d = self.predecir([{"variable": "pm2_5", "valor": 20}]).json()
        self.assertFalse(d["clima"]["disponible"])
        nombres = {f["variable"] for k in ("pm2_5", "pm10")
                   for lado in ("favorables", "desfavorables") for f in d["explicacion"][k]["simple"][lado]}
        self.assertTrue(nombres <= set(cat.VARIABLES) | set(cat.CLIMA))

    def test_con_pronostico_del_clima(self):
        from .ml_service import obtener_servicio
        s = obtener_servicio()
        hoy = {c: s.clima_mes[1][c] for c in meteo.COLS_METEO}
        lluvioso = {**hoy, "precipitacion_sum": 30.0}
        try:
            s.meteo_en_linea, s._cache_meteo = True, None
            with mock.patch("simulador.ml_service.descargar_hoy_y_manana", return_value=(hoy, lluvioso, "2026-01-15")):
                d = self.predecir([{"variable": "pm2_5", "valor": 20}]).json()
        finally:
            s.meteo_en_linea, s._cache_meteo = False, None
        self.assertTrue(d["clima"]["disponible"])
        lluvia = next(x for x in d["clima"]["resumen"] if x["id"] == "lluvia")
        self.assertEqual(lluvia["valor"], 30.0)

    def test_agregacion_diaria_igual_al_notebook(self):
        import pandas as pd
        t = pd.date_range("2026-01-01", periods=48, freq="h")
        h = pd.DataFrame({"time": t, "temperature_2m": 20.0, "relative_humidity_2m": 80.0, "precipitation": 0.5,
                          "wind_speed_10m": 10.0, "wind_direction_10m": 90.0, "shortwave_radiation": 100.0,
                          "cloud_cover": 50.0, "surface_pressure": 850.0, "boundary_layer_height": 400.0})
        d = meteo.agregar_diario(h)
        self.assertEqual(set(d.columns) - {"date"}, set(meteo.COLS_METEO))
        self.assertAlmostEqual(d["precipitacion_sum"].iloc[0], 12.0)
        self.assertAlmostEqual(d["viento_u_media"].iloc[0], -10.0)


class PaginaYCatalogoTests(BaseConModelos):
    def test_inicio_renderiza_constructor_y_catalogo(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, 'id="catalogo-variables"')
        self.assertContains(r, 'id="lista-variables"')
        self.assertContains(r, "csrf-token")
        self.assertContains(r, "PM₂.₅ mañana")
        self.assertContains(r, "Recomendaciones para tu día")
        self.assertContains(r, "¿Por qué cambia el aire mañana?")
        self.assertContains(r, 'aria-label="Escala de calidad; se resaltará al calcular el pronóstico"')
        self.assertContains(r, 'class="rec-card rec-card--pendiente"', count=3)
        self.assertNotContains(r, 'id="bienvenida"')
        self.assertContains(r, "Sube la contaminación")
        self.assertContains(r, "Baja el pronóstico")
        self.assertContains(r, 'id="clima-manana"')
        self.assertNotContains(r, "Modo técnico")
        self.assertNotContains(r, "Precisión del Modelo")
        self.assertNotContains(r, 'id="ficha-modelo"')
        self.assertNotContains(r, 'id="grafico-cascada"')

    def test_endpoints_de_metricas_tecnicas_no_estan_disponibles(self):
        self.assertEqual(self.client.get("/api/benchmark/").status_code, 404)
        self.assertEqual(self.client.get("/api/estado/").status_code, 404)

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
        self.assertEqual((por_id["pm2_5"]["min_valido"], por_id["pm2_5"]["max_valido"]), (0.0, 5000.0))
        self.assertEqual((por_id["aerosol_optical_depth"]["min_valido"],
                          por_id["aerosol_optical_depth"]["max_valido"]), (0.0, 5.0))
        self.assertEqual((por_id["uv_index"]["min_valido"], por_id["uv_index"]["max_valido"]), (0.0, 50.0))
        self.assertEqual(por_id["nitrogen_dioxide"]["nombre_largo"], "Dióxido de nitrógeno")
        self.assertEqual(por_id["nitrogen_dioxide"]["unidad"], "µg/m³")
        self.assertNotIn("temperature", ids)
        self.assertNotIn("relative_humidity", ids)
        self.assertNotIn("wind_speed", ids)


class PrediccionTests(BaseConModelos):
    def test_subconjunto_de_variables_y_explicacion_publica(self):
        r = self.predecir([{"variable": "pm2_5", "valor": "21,5"},
                           {"variable": "nitrogen_dioxide", "valor": 18}])
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(len(d["entrada"]["ingresadas"]), 2)
        self.assertEqual(len(d["entrada"]["estimadas"]), 7)
        self.assertEqual(d["entrada"]["completitud"], {
            "ingresadas": 2, "total": len(cat.VARIABLES), "porcentaje": 22.2,
        })
        self.assertNotIn("tecnico", d)
        self.assertNotIn("cobertura", d)
        for clave in ("pm2_5", "pm10"):
            self.assertEqual(set(d["predicciones"][clave]), {"valor", "nivel"})
            self.assertEqual(set(d["explicacion"][clave]), {"simple"})
        self.assertEqual(len(d["recomendaciones"]), len(cat.ACTIVIDADES))
        ids_recomendaciones = {r["id"] for r in d["recomendaciones"]}
        self.assertTrue({"running", "sensibles", "ventilacion"}.issubset(ids_recomendaciones))
        self.assertIn(d["alerta"]["nivel"], [n["id"] for n in cat.NIVELES])

    def test_explicacion_para_publico_general(self):
        d = self.predecir([{"variable": "pm2_5", "valor": 30}]).json()
        a = d["alerta"]
        for k in ("cara", "titulo", "frase"):
            self.assertTrue(a[k])
        s = d["explicacion"][a["contaminante"]]["simple"]
        self.assertLessEqual(len(s["desfavorables"]), 3)
        self.assertLessEqual(len(s["favorables"]), 3)
        self.assertAlmostEqual(
            s["prediccion"], d["predicciones"][a["contaminante"]]["valor"], delta=0.011)
        self.assertTrue(all(f["aporte"] >= 0 for f in s["desfavorables"]))
        self.assertTrue(all(f["aporte"] <= 0 for f in s["favorables"]))
        for f in s["desfavorables"] + s["favorables"]:
            if f["tipo"] == "aire":
                self.assertIn("µg/m³", f["unidad"])
            self.assertIn("—", f["nombre"])
        self.assertTrue(all(len(r["corto"].split()) <= 6 for r in d["recomendaciones"]))

    def test_todas_las_variables_evitan_estimaciones(self):
        todas = self.predecir([{"variable": v, "valor": cat_v, "valor_previo": cat_v}
                               for v, cat_v in [("pm2_5", 15), ("pm10", 20),
                                                ("carbon_monoxide", 400),
                                                ("nitrogen_dioxide", 14),
                                                ("sulphur_dioxide", 4), ("ozone", 55),
                                                ("aerosol_optical_depth", 0.24),
                                                ("dust", 0), ("uv_index", 1.8)]]).json()
        self.assertEqual(todas["entrada"]["estimadas"], [])
        self.assertEqual(todas["entrada"]["completitud"]["ingresadas"], len(cat.VARIABLES))
        self.assertEqual(todas["entrada"]["completitud"]["porcentaje"], 100.0)

    def test_lectura_actual_extrema_eleva_el_semaforo(self):
        d = self.predecir([{"variable": "pm2_5", "valor": 80}]).json()
        self.assertEqual(d["alerta"]["nivel"], "alto")
        self.assertEqual(d["alerta"]["fuente"], "lectura_actual")
        self.assertTrue(d["avisos"])

    def test_acepta_valores_superiores_al_maximo_historico(self):
        r = self.predecir([{"variable": "pm10", "valor": 9000}])
        self.assertEqual(r.status_code, 200, r.json())
        datos = r.json()
        self.assertEqual(datos["entrada"]["ingresadas"][0]["valor"], 9000)
        self.assertTrue(any("menos confiable" in aviso for aviso in datos["avisos"]))

    def test_acepta_limites_superiores_plausibles(self):
        variables = [{"variable": variable, "valor": meta["max_valido"]}
                     for variable, meta in cat.VARIABLES.items()]
        respuesta = self.predecir(variables)
        self.assertEqual(respuesta.status_code, 200, respuesta.json())
        self.assertEqual(len(respuesta.json()["entrada"]["ingresadas"]), len(cat.VARIABLES))

    def test_errores_de_validacion(self):
        casos = [
            [],
            [{"variable": "us_aqi", "valor": 50}],
            [{"variable": "pm10", "valor": "abc"}],
            [{"variable": "pm10", "valor": -3}],
            [{"variable": "pm10", "valor": 10000.01}],
            [{"variable": "uv_index", "valor": 50.01}],
            [{"variable": "aerosol_optical_depth", "valor": 5.01}],
            [{"variable": "pm10", "valor": 10, "valor_previo": 10000.01}],
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
        self.assertEqual(nombre_canonico("viento_vel_media_lag1"), "viento_vel_media_lag1")
        self.assertEqual(variable_de("precipitacion_sum_lag1"), "lluvia")
        self.assertEqual(variable_de("temp_media"), "temperatura")
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