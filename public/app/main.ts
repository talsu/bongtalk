import { bootstrap } from '@angular/platform-browser-dynamic';
import { HTTP_PROVIDERS } from '@angular/http';

import { AppComponent } from './app.component';
import { appRouterProviders } from './app.routes';
import { ApiClient } from './api-client';

bootstrap(AppComponent, [
  appRouterProviders,
  HTTP_PROVIDERS,
  ApiClient
]);

// import { UpgradeAdapter } from '@angular/upgrade';
//
// /* . . . */
// const upgradeAdapter = new UpgradeAdapter();
// upgradeAdapter.bootstrap(document.body, ['bongtalkApp'], {strictDi: true});
