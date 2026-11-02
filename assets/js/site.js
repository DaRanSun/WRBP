// 两个站点的地址：单机版（静态，Netlify）和联机版（Cloudflare Workers）。互相跳转时用。
(function (root) {
    'use strict';
    root.WRBP = root.WRBP || {};
    root.WRBP.site = {
        solo: 'https://wrbp.netlify.app/',
        online: 'https://wrbp.wrbp.workers.dev/',
    };
})(window);
