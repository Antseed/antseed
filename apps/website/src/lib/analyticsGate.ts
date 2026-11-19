// Imported by docusaurus.config.ts (Node), so this file must not import anything.

/**
 * Loads Google Tag Manager off the critical path: on the first real interaction (pointer, key, touch, scroll, move), or 2s after the
 * page has loaded, whichever comes first. Waiting for `load` keeps its scripts from competing with the hero for a slow phone's
 * bandwidth (an idle callback could fire before the hero painted); 2s after it, a quick bounce is still counted. GA4 and any ad/social pixels
 * are tags *inside* the container, so
 * this one gate defers all of them without changing what is tracked. `dataLayer` is created immediately, so events the site pushes
 * before GTM arrives queue and are processed once it loads. Injected verbatim through `headTags`.
 */
export const deferredGtmScript = (containerId: string): string =>
  `(function(w,d,id){w.dataLayer=w.dataLayer||[];var done;function load(){if(done)return;done=1;` +
  `w.dataLayer.push({'gtm.start':Date.now(),event:'gtm.js'});var j=d.createElement('script');j.async=true;` +
  `j.src='https://www.googletagmanager.com/gtm.js?id='+id;d.head.appendChild(j);}` +
  `var ev=['pointerdown','keydown','touchstart','scroll','mousemove'];` +
  `function once(){ev.forEach(function(e){w.removeEventListener(e,once)});load();}` +
  `ev.forEach(function(e){w.addEventListener(e,once,{passive:true})});` +
  `function later(){setTimeout(load,2000)}` +
  `if(d.readyState==='complete'){later()}else{w.addEventListener('load',later)}` +
  `})(window,document,${JSON.stringify(containerId)});`;
