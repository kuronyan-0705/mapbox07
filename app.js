(async function boot() {
  const remoteConfig = await loadRemoteConfig();
  const MAPBOX_TOKEN =
    window.MAPBOX_TOKEN ||
    remoteConfig.mapboxToken ||
    new URLSearchParams(location.search).get("token") ||
    "";
  const STORYLINE_URL = "./storyline.json";
  const ROUTE_URL = "./route128.geojson";

  const state = {
    storyline: null,
    sceneIndex: -1,
    activeOverlayId: null,
    activeOverlayOpacity: 0,
    autoplayTimer: null,
    heartbeatFrame: null,
    heartbeatRouteId: null,
    mapReady: false
  };

  const titleCard = document.getElementById("title-card");
  const sceneTitle = document.getElementById("scene-title");
  const status = document.getElementById("status");

  if (!MAPBOX_TOKEN) {
    status.textContent = "Set MAPBOX_TOKEN in Vercel, or open with ?token=YOUR_MAPBOX_TOKEN";
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: [140.34, 35.33],
    zoom: 10.5,
    pitch: 44,
    bearing: 0,
    antialias: true,
    attributionControl: false,
    logoPosition: "bottom-left"
  });

  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();

  await onceMapEvent(map, "load");
  await addRouteSourceAndLayers(map, ROUTE_URL);
  hideModernPoiLabels(map);

  state.storyline = await loadStoryline(remoteConfig, STORYLINE_URL);
  document.body.classList.add("ready");
  status.textContent = "Space: next scene / R: autoplay / L: old map opacity";

  await waitForIdle(map);
  state.mapReady = true;
  goToScene(0);

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      goToScene(state.sceneIndex + 1);
    }
    if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      startAutopilot();
    }
    if (event.key.toLowerCase() === "l") {
      event.preventDefault();
      toggleCurrentOverlay();
    }
  });

  async function goToScene(nextIndex, options = {}) {
    const scenes = state.storyline.scenes;
    if (!scenes.length) return;

    const index = ((nextIndex % scenes.length) + scenes.length) % scenes.length;
    const scene = scenes[index];
    state.sceneIndex = index;

    status.textContent = `${index + 1}/${scenes.length}: ${scene.title}`;
    sceneTitle.textContent = scene.title;

    await waitForIdle(map);
    titleCard.classList.remove("visible");

    fadeOutCurrentOverlay();
    pulseRoute(scene.highlightRouteId);

    map.flyTo({
      center: scene.lngLat,
      zoom: scene.zoom,
      pitch: scene.pitch,
      bearing: scene.bearing,
      duration: options.instant ? 0 : scene.duration,
      curve: 1.42,
      speed: 0.58,
      essential: true
    });

    await onceMapEvent(map, "moveend");
    await waitForIdle(map);

    if (scene.overlayImage && scene.overlayCoords) {
      await showImageOverlay(scene);
    }

    titleCard.classList.add("visible");
  }

  function startAutopilot() {
    stopAutopilot();
    goToScene(0, { instant: state.sceneIndex === -1 });
    const scenes = state.storyline.scenes;
    let next = 1;

    const scheduleNext = () => {
      const current = scenes[state.sceneIndex];
      state.autoplayTimer = window.setTimeout(async () => {
        await goToScene(next);
        next = (next + 1) % scenes.length;
        scheduleNext();
      }, Math.max(2500, current.duration + 1800));
    };

    scheduleNext();
  }

  function stopAutopilot() {
    if (state.autoplayTimer) {
      window.clearTimeout(state.autoplayTimer);
      state.autoplayTimer = null;
    }
  }

  async function showImageOverlay(scene) {
    const sourceId = `old-map-${scene.id}`;
    const layerId = `${sourceId}-layer`;

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, {
        type: "image",
        url: scene.overlayImage,
        coordinates: scene.overlayCoords
      });
      map.addLayer({
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: {
          "raster-opacity": 0,
          "raster-fade-duration": 0
        }
      }, "route128-pulse");
    }

    state.activeOverlayId = layerId;
    state.activeOverlayOpacity = 1;
    await fadeLayer(layerId, "raster-opacity", 0, 0.82, 1400);
  }

  function fadeOutCurrentOverlay() {
    if (!state.activeOverlayId || !map.getLayer(state.activeOverlayId)) return;
    const layerId = state.activeOverlayId;
    fadeLayer(layerId, "raster-opacity", currentLayerOpacity(layerId), 0, 900).then(() => {
      if (map.getLayer(layerId)) map.setPaintProperty(layerId, "raster-opacity", 0);
    });
    state.activeOverlayId = null;
    state.activeOverlayOpacity = 0;
  }

  function toggleCurrentOverlay() {
    if (!state.activeOverlayId || !map.getLayer(state.activeOverlayId)) return;
    const nextOpacity = state.activeOverlayOpacity > 0 ? 0 : 0.82;
    fadeLayer(state.activeOverlayId, "raster-opacity", currentLayerOpacity(state.activeOverlayId), nextOpacity, 520);
    state.activeOverlayOpacity = nextOpacity;
  }

  function pulseRoute(routeId) {
    if (!routeId || !map.getLayer("route128-pulse")) return;
    state.heartbeatRouteId = routeId;
    const started = performance.now();

    if (state.heartbeatFrame) cancelAnimationFrame(state.heartbeatFrame);

    const step = (now) => {
      const seconds = (now - started) / 1000;
      const irregularBeat =
        Math.pow(Math.sin(seconds * 4.7), 8) * 0.55 +
        Math.pow(Math.sin(seconds * 7.9 + 1.6), 12) * 0.35 +
        Math.pow(Math.sin(seconds * 2.1 + 0.9), 6) * 0.18;
      const opacity = clamp(0.2 + irregularBeat, 0.2, 1);

      map.setPaintProperty("route128-pulse", "line-opacity", [
        "case",
        ["==", ["get", "id"], state.heartbeatRouteId],
        opacity,
        0
      ]);

      state.heartbeatFrame = requestAnimationFrame(step);
    };

    state.heartbeatFrame = requestAnimationFrame(step);
  }

  function currentLayerOpacity(layerId) {
    const value = map.getPaintProperty(layerId, "raster-opacity");
    return typeof value === "number" ? value : 0;
  }

  function hideModernPoiLabels(targetMap) {
    const hiddenPatterns = [
      /poi-label/,
      /transit-label/,
      /airport-label/,
      /settlement-subdivision-label/,
      /building-number-label/
    ];

    const layers = targetMap.getStyle().layers || [];
    for (const layer of layers) {
      const isSymbol = layer.type === "symbol";
      const isModernLabel = hiddenPatterns.some((pattern) => pattern.test(layer.id));
      if (isSymbol && isModernLabel) {
        targetMap.setLayoutProperty(layer.id, "visibility", "none");
      }
    }
  }

  async function addRouteSourceAndLayers(targetMap, routeUrl) {
    targetMap.addSource("route128", {
      type: "geojson",
      data: routeUrl
    });

    targetMap.addLayer({
      id: "route128-base",
      type: "line",
      source: "route128",
      paint: {
        "line-color": "#334155",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 14, 5, 17, 10],
        "line-opacity": 0.28
      }
    });

    targetMap.addLayer({
      id: "route128-pulse",
      type: "line",
      source: "route128",
      paint: {
        "line-color": "#f7d154",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 7, 17, 13],
        "line-blur": 1.2,
        "line-opacity": 0
      }
    });
  }

  function fadeLayer(layerId, property, from, to, duration) {
    return new Promise((resolve) => {
      const started = performance.now();

      const step = (now) => {
        if (!map.getLayer(layerId)) {
          resolve();
          return;
        }

        const progress = clamp((now - started) / duration, 0, 1);
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        const value = from + (to - from) * eased;

        map.setPaintProperty(layerId, property, value);

        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      };

      requestAnimationFrame(step);
    });
  }

  function waitForIdle(targetMap) {
    if (targetMap.loaded() && targetMap.areTilesLoaded()) return Promise.resolve();
    return onceMapEvent(targetMap, "idle");
  }

  function onceMapEvent(targetMap, eventName) {
    return new Promise((resolve) => targetMap.once(eventName, resolve));
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    return response.json();
  }

  async function loadRemoteConfig() {
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) return {};
      return response.json();
    } catch (error) {
      return {};
    }
  }

  async function loadStoryline(config, fallbackUrl) {
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      return fetchJson(fallbackUrl);
    }

    try {
      const endpoint = `${config.supabaseUrl}/rest/v1/scenes?select=*&order=sort_order.asc`;
      const response = await fetch(endpoint, {
        headers: {
          apikey: config.supabaseAnonKey,
          authorization: `Bearer ${config.supabaseAnonKey}`
        }
      });

      if (!response.ok) throw new Error(`Supabase scenes failed: ${response.status}`);
      const rows = await response.json();
      if (!rows.length) return fetchJson(fallbackUrl);

      return {
        scenes: rows.map((row) => ({
          id: row.id,
          title: row.title,
          lngLat: row.lng_lat,
          zoom: row.zoom,
          pitch: row.pitch,
          bearing: row.bearing,
          duration: row.duration,
          overlayImage: row.overlay_image,
          overlayCoords: row.overlay_coords,
          highlightRouteId: row.highlight_route_id
        }))
      };
    } catch (error) {
      console.warn(error);
      return fetchJson(fallbackUrl);
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
}());
