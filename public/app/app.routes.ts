import { provideRouter, RouterConfig, Route }  from '@angular/router';
import { LoginComponent } from './login.component';
import { BootComponent } from './boot.component';
import { MainComponent } from './main.component';
import { ChatListComponent } from './chat-list.component';
import { SettingListComponent } from './setting-list.component';

import { EmptyComponent } from './empty.component';

const depth3Routes: Route[] = [
    { path: '', component: EmptyComponent },
    { path: 'session', component: EmptyComponent },
    { path: 'session-info', component: EmptyComponent },
    { path: 'set-profile', component: EmptyComponent },
    { path: 'set-username', component: EmptyComponent },
    { path: 'set-password', component: EmptyComponent },
    { path: 'start-public-chat', component: EmptyComponent },
    { path: 'start-personal-chat', component: EmptyComponent },
    { path: 'start-group-chat', component: EmptyComponent },
    { path: 'admin-user-management', component: EmptyComponent },
    { path: 'admin-session-management', component: EmptyComponent }
];

const routes: RouterConfig = [
    { path: 'login', component: LoginComponent },
    { path: 'signout', component: LoginComponent },
    { path: 'signin', component: LoginComponent },
    { path: 'signup', component: LoginComponent },
    {
        path: 'main',
        component: MainComponent,
        children: [
            {
                path: '',
                redirectTo: '/main/chats',
                pathMatch: 'full'
            },
            {
                path: 'chats',
                component: ChatListComponent,
                children: depth3Routes
            },
            {
                path: 'settings',
                component: SettingListComponent,
                children: depth3Routes
            }
        ]
    },
    {
        path: '',
        component: BootComponent
    }
];

export const appRouterProviders = [
    provideRouter(routes)
];
