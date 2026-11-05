/* Inline SVG icon set with Lucide-style strokes. */
(function () {
  "use strict";

  const paths = {
    air: '<path d="M3 8h12a3 3 0 1 0-3-3"/><path d="M2 12h17a3 3 0 1 1-3 3"/><path d="M4 16h6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    x: '<path d="m18 6-12 12"/><path d="m6 6 12 12"/>',
    particles: '<circle cx="7" cy="8" r="2"/><circle cx="16" cy="6" r="1.5"/><circle cx="14" cy="15" r="2.5"/><circle cx="5" cy="17" r="1"/><path d="M9 8h4m-6 2 1 5m5-7 2-1"/>',
    dust: '<path d="M3 15h13a3 3 0 1 0-2.8-4"/><path d="M2 11h7a3 3 0 1 0-2.8-4"/><path d="M5 19h12"/>',
    car: '<path d="m5 11 1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><path d="M3 11h18v7H3z"/><path d="M6 18v2m12-2v2"/><circle cx="7" cy="14.5" r=".7"/><circle cx="17" cy="14.5" r=".7"/>',
    traffic: '<path d="M7 3h10v18H7z"/><circle cx="12" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="17" r="1.5"/>',
    factory: '<path d="M3 21V9l6 3V8l6 4V5h4v16Z"/><path d="M7 17h1m3 0h1m3 0h1"/><path d="M16 5V3h3v2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    haze: '<path d="M4 10h13a3 3 0 1 0-3-3"/><path d="M2 14h17a3 3 0 1 1-3 3"/><path d="M5 18h6"/>',
    dunes: '<path d="M2 19c4-7 7-7 11 0 3-5 5-6 9-5"/><path d="M2 21h20"/>',
    bike: '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="m15 6 3 0m-9 11.5 3-7h4l3 7m-7-7-2-3H7m2 3 3 7"/>',
    run: '<circle cx="14" cy="5" r="2"/><path d="m12 22 2-7-4-3 3-5 4 3 3 1"/><path d="m10 12-4 4-4 1m10-5 4 4 4 1"/>',
    mask: '<path d="M4 9c0-2 3.6-4 8-4s8 2 8 4v5c0 3-3 5-8 5s-8-2-8-5Z"/><path d="M4 10 1 9m19 1 3-1M8 11v2m4-2v2m4-2v2"/>',
    window: '<path d="M4 3h16v18H4z"/><path d="M12 3v18M4 12h16"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    dotCircle: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    triangleAlert: '<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
    shieldAlert: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="M12 8v4m0 4h.01"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="m8.2 13-1.2 8 5-3 5 3-1.2-8"/>',
    ruler: '<path d="m21.3 8.7-6-6a1 1 0 0 0-1.4 0l-11.2 11.2a1 1 0 0 0 0 1.4l6 6a1 1 0 0 0 1.4 0L21.3 10a1 1 0 0 0 0-1.3Z"/><path d="m7.5 10.5 2 2m1-5 2 2m1-5 2 2m-5 7 2 2"/>',
    bolt: '<path d="m13 2-3 9h7l-6 11 3-9H7l6-11Z"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    arrowUp: '<path d="M12 19V5m-7 7 7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14m7-7-7 7-7-7"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
    rotateCcw: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
    rain: '<path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3"/><path d="M8 19v2M8 13v2M12 21v2M12 15v2M16 19v2M16 13v2"/>',
    thermo: '<path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    drop: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5 12 2.5C11.5 5 10 7.4 8 9 6 10.6 5 12.5 5 15a7 7 0 0 0 7 7Z"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
  };

  function svg(name, className = "icon") {
    const body = paths[name];
    if (!body) throw new Error(`Icono SVG desconocido: ${name}`);
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  window.Iconos = { svg };
  document.querySelectorAll("[data-icon]").forEach((node) => {
    node.innerHTML = svg(node.dataset.icon, node.dataset.iconClass || "icon");
  });
})();
