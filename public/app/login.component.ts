import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClient } from './api-client';
import { CookieService } from 'angular2-cookie/core';
import { User, ViewModel } from './view-model';
import { Validator, ValidationResult } from './validator';

@Component({
  selector : 'bongtalk-app',
  templateUrl : './app/login.component.html',
  providers : [ CookieService, Validator ]
})
export class LoginComponent {
  constructor(
    private router: Router,
    private apiClient: ApiClient,
    private cookieService: CookieService,
    private validator: Validator
  ){}
  user:User = new User();
  usernameValidationResult: ValidationResult = new ValidationResult();

  usernameChanged(newValue:string) {
    this.usernameValidationResult = this.validator.validateUsername(newValue);
    this.user.name = newValue;
  }

  usernameKeypress($event){
    if ($event.keyCode == 13 && $event.key == 'Enter'){
      this.signInByGuest();
    }
  }

  signInByGuest() {
    if (!this.user.name){
      this.usernameValidationResult = {
        status:'error',
        comment:'User name is empty',
        ok: false
      };
      return;
    }

    this.usernameValidationResult = this.validator.validateUsername(this.user.name);
    if (this.usernameValidationResult.status != 'success'){
      return;
    }

    this.apiClient.signInByGuest(this.user).subscribe(
      result => {
        this.cookieService.putObject('auth_token', {token:result.token, expire:result.tokenExpire}, {expires:new Date(result.tokenExpire*1000)});
        this.router.navigate(['/main/chats/start-public-chat']);
      },
      err => {
        this.usernameValidationResult = {
          status:'error',
          comment: JSON.stringify(err),
          ok: false
        };
      }
    );
  }

  goSignIn() {
    this.router.navigate(['/signin']);
  }

  goSignUp() {
    this.router.navigate(['/signup']);
  }
}
