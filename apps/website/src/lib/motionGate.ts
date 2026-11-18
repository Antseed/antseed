// Imported by docusaurus.config.ts (Node), so this file must not import anything.

/**
 * Runs in <head> before the first paint: enables the hidden-until-revealed states (reveal, painting arrival) only when motion is
 * allowed and this isn't a still capture. If the app never hydrates, the states are dropped after 4s so content can't stay hidden.
 */
export const MOTION_GATE_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search);if(q.has('still')||q.has('demo')||matchMedia('(prefers-reduced-motion: reduce)').matches)return;var r=document.documentElement;r.dataset.motion='';setTimeout(function(){if(!window.__siteMotionReady)delete r.dataset.motion},4000)}catch(e){}})();`;
