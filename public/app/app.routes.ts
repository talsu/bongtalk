import { provideRouter, RouterConfig }  from '@angular/router';
import { LoginComponent } from './login.component';
import { BootComponent } from './boot.component';

const routes: RouterConfig = [
  {
    path: 'login',
    component: LoginComponent
  },
  {
    path: '',
    component: BootComponent
  }
];

export const appRouterProviders = [
  provideRouter(routes)
];
