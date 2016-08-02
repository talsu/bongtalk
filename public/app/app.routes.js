"use strict";
var router_1 = require('@angular/router');
var login_component_1 = require('./login.component');
var boot_component_1 = require('./boot.component');
var main_component_1 = require('./main.component');
var chat_list_component_1 = require('./chat-list.component');
var empty_component_1 = require('./empty.component');
var depth3Routes = [
    { path: '', component: empty_component_1.EmptyComponent },
    { path: 'session', component: empty_component_1.EmptyComponent },
    { path: 'session-info', component: empty_component_1.EmptyComponent },
    { path: 'set-profile', component: empty_component_1.EmptyComponent },
    { path: 'set-username', component: empty_component_1.EmptyComponent },
    { path: 'set-password', component: empty_component_1.EmptyComponent },
    { path: 'start-public-chat', component: empty_component_1.EmptyComponent },
    { path: 'start-personal-chat', component: empty_component_1.EmptyComponent },
    { path: 'start-group-chat', component: empty_component_1.EmptyComponent },
    { path: 'admin-user-management', component: empty_component_1.EmptyComponent },
    { path: 'admin-session-management', component: empty_component_1.EmptyComponent }
];
var routes = [
    { path: 'login', component: login_component_1.LoginComponent },
    {
        path: 'main',
        component: main_component_1.MainComponent,
        children: [
            {
                path: '',
                redirectTo: '/main/chats',
                pathMatch: 'full'
            },
            {
                path: 'chats',
                component: chat_list_component_1.ChatListComponent,
                children: depth3Routes
            },
            {
                path: 'settings',
                component: empty_component_1.EmptyComponent,
                children: depth3Routes
            }
        ]
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