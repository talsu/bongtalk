"use strict";
var router_1 = require('@angular/router');
var login_component_1 = require('./login.component');
var boot_component_1 = require('./boot.component');
var routes = [
    {
        path: 'login',
        component: login_component_1.LoginComponent
    },
    {
        path: '',
        component: boot_component_1.BootComponent
    }
];
exports.appRouterProviders = [
    router_1.provideRouter(routes)
];
//# sourceMappingURL=app.routes.js.map