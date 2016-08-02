import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClient } from './api-client';
import { CookieService } from 'angular2-cookie/core';
import { User, ViewModel } from './view-model';

@Component({
  selector : 'bongtalk-app',
  templateUrl : './app/login.component.html',
  providers : [ CookieService ]
})
export class LoginComponent {
  constructor(private router: Router, private apiClient: ApiClient, private cookieService: CookieService){}
  user:User = new User();

  usernameChanged(newValue:string) {
    console.log(newValue);
    this.user.name = newValue;
  }

  usernameKeypress($event){
    if ($event.keyCode == 13 && $event.key == 'Enter'){
      this.signInByGuest();
    }
  }

  signInByGuest() {
    this.apiClient.signInByGuest(this.user).subscribe(
      result => {
        this.cookieService.putObject('auth_token', {token:result.token, expire:result.tokenExpire}, {expires:new Date(result.tokenExpire*1000)});
        this.router.navigate(['/main/chats/start-public-chat']);
      },
      err => console.log(err)
    );
  }

  goSignIn() {
    this.router.navigate(['/signin']);
  }

  goSignUp() {
    this.router.navigate(['/signup']);
  }
}
