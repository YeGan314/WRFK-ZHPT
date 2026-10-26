import { createApp } from "vue";

const isWrfx = /^\/wrfx(?:\/|$)/.test(window.location.pathname);
const [{ default: App }] = await Promise.all([
  isWrfx ? import("./wrfx/App.vue") : import("./App.vue"),
  isWrfx ? import("./wrfx/styles.css") : import("./styles/main.css"),
  isWrfx ? Promise.resolve() : import("ol/ol.css"),
]);

createApp(App).mount("#app");
