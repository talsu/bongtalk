"use strict";
var platform_browser_dynamic_1 = require('@angular/platform-browser-dynamic');
var http_1 = require('@angular/http');
var app_component_1 = require('./app.component');
var app_routes_1 = require('./app.routes');
var api_client_1 = require('./api-client');
platform_browser_dynamic_1.bootstrap(app_component_1.AppComponent, [
    app_routes_1.appRouterProviders,
    http_1.HTTP_PROVIDERS,
    api_client_1.ApiClient
]);
// import { UpgradeAdapter } from '@angular/upgrade';
//
// /* . . . */
// const upgradeAdapter = new UpgradeAdapter();
// upgradeAdapter.bootstrap(document.body, ['bongtalkApp'], {strictDi: true});
//# sourceMappingURL=main.js.map