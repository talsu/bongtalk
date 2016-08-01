import { Component } from '@angular/core';
import { ROUTER_DIRECTIVES } from '@angular/router';
import './rxjs-operators';

@Component({
  selector : 'bongtalk-app',
  templateUrl : './app/app.component.html',
  directives : [ROUTER_DIRECTIVES]
})
export class AppComponent {

}
