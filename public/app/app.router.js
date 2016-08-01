"use strict";
var router_1 = require('@angular/router');
var heroes_component_1 = require('./heroes.component');
var routes = [
    {
        path: 'heroes',
        component: heroes_component_1.HeroesComponent
    }
];
exports.appRouterProviders = [
    router_1.provideRouter(routes)
];
//# sourceMappingURL=app.router.js.map