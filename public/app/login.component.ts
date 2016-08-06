import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClient } from './api-client';
import { CookieService } from 'angular2-cookie/core';
import { User, ViewModel } from './view-model';
import { Validator, ValidationResult } from './validator';
import { AutoProxyPipe } from './pipes';

@Component({
  selector : 'bongtalk-login',
  templateUrl : './templates/login.component.html',
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

@Component({
  selector : 'bongtalk-signout',
  template : '',
  providers : [ CookieService ]
})
export class SignoutComponent implements OnInit {
  constructor(
    private router: Router,
    private cookieService: CookieService,
    private viewModel: ViewModel
  ){}

  ngOnInit(){
    this.cookieService.remove('auth_token');
    this.viewModel.unload();
    this.router.navigate(['/login']);
  }
}

@Component({
  selector : 'bongtalk-signin',
  templateUrl : './templates/signin.component.html',
  providers : [ CookieService, Validator ]
})
export class SigninComponent {
  constructor(
    private router: Router,
    private apiClient: ApiClient,
    private cookieService: CookieService,
    private validator: Validator
  ){}
  user:User = new User();
  userIdValidationResult: ValidationResult = new ValidationResult();
  userPasswordValidationResult: ValidationResult = new ValidationResult();
  loginResult: string = '';

  userIdChanged(newValue: string) {
    this.user.id = newValue;
    this.userIdValidationResult = {
      status: this.user.id?'success':'',
      comment:'',
      ok: true
    };
  }

  passwordChanged(newValue: string) {
    this.user.password = newValue;
    this.userPasswordValidationResult = {
      status: this.user.password?'success':'',
      comment:'',
      ok: true
    };
  }

  inputKeypress($event){
    if ($event.keyCode == 13 && $event.key == 'Enter'){
      this.signIn();
    }
  }

  signIn() {
    if (this.userIdValidationResult.status != 'success' || this.userPasswordValidationResult.status != 'success') return;
    this.loginResult = '';
    this.apiClient.signIn(this.user.id, this.user.password)
    .subscribe(
      result => {
        if (!result || !result.token){
          this.loginResult = 'error';
        }
        else {
          this.loginResult = 'success';
          this.cookieService.putObject('auth_token', {token:result.token, expire:result.tokenExpire}, {expires:new Date(result.tokenExpire*1000)});
          this.router.navigate(['/main/chats']);
        }
      },
      error => this.loginResult = 'error'
    );
  }

  back() {
    this.router.navigate(['/login']);
  }
}

@Component({
  selector : 'bongtalk-signup',
  templateUrl : './templates/signup.component.html',
  providers : [ CookieService, Validator ],
  pipes : [ AutoProxyPipe ]
})
export class SignupComponent implements OnInit {
  constructor(
    private router: Router,
    private apiClient: ApiClient,
    private cookieService: CookieService,
    private validator: Validator
  ){}
  user:User = new User();
  userIdValidationResult: ValidationResult = new ValidationResult();
  userPasswordValidationResult: ValidationResult = new ValidationResult();
  avatarUrl:string;

  ngOnInit(){
    this.chageAvatarUrlRandom();
  }

  userIdChanged(newValue: string) {
    this.user.id = newValue;
    this.userIdValidationResult = this.validator.validateUserId(newValue);
    if (this.userIdValidationResult.ok){
      this.apiClient.checkUserExist(this.user.id)
      .subscribe(
        result => this.userIdValidationResult = result ? {
          status:'error',
          comment:'Aleady exists.',
          ok: false
        }: {
          status:'success',
          comment:'',
          ok: true
        },
        err => this.userIdValidationResult = {
          status:'success',
          comment:'',
          ok: true
        }
      );
    }
  }

  passwordChanged(newValue: string) {
    this.user.password = newValue;
    this.userPasswordValidationResult = this.validator.validatePassword(this.user.password);
  }

  chageAvatarUrlRandom() {
    this.apiClient.getRandomAvatarUrl().subscribe(result => this.avatarUrl = result);
  }

  back() {
    this.router.navigate(['/login']);
  }

  inputKeypress($event){
    if ($event.keyCode == 13 && $event.key == 'Enter'){
      this.signUp();
    }
  }

  signUp() {
    if (!this.validator.validateUserId(this.user.id) || !this.validator.validatePassword(this.user.password)) return;

    this.apiClient.signUp(this.user)
    .subscribe(
      result => {
        // signin
        if (result && result.result && result.result.ok){
          this.apiClient.signIn(this.user.id, this.user.password)
          .subscribe(result => {
            if (!result.token) {
              alert('Empty token.');
              return;
            }

            this.cookieService.putObject('auth_token', {token:result.token, expire:result.tokenExpire}, {expires:new Date(result.tokenExpire*1000)});
            this.router.navigate(['/main/chats/set-username/first']);
          });
        }
        else {
          alert('Bad response.');
        }
      },
      err => {
        alert(JSON.stringify(err));
      }
    );
  }
}
