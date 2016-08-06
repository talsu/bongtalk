"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var core_1 = require('@angular/core');
var router_1 = require('@angular/router');
var api_client_1 = require('./api-client');
var core_2 = require('angular2-cookie/core');
var view_model_1 = require('./view-model');
var validator_1 = require('./validator');
var pipes_1 = require('./pipes');
var LoginComponent = (function () {
    function LoginComponent(router, apiClient, cookieService, validator) {
        this.router = router;
        this.apiClient = apiClient;
        this.cookieService = cookieService;
        this.validator = validator;
        this.user = new view_model_1.User();
        this.usernameValidationResult = new validator_1.ValidationResult();
    }
    LoginComponent.prototype.usernameChanged = function (newValue) {
        this.usernameValidationResult = this.validator.validateUsername(newValue);
        this.user.name = newValue;
    };
    LoginComponent.prototype.usernameKeypress = function ($event) {
        if ($event.keyCode == 13 && $event.key == 'Enter') {
            this.signInByGuest();
        }
    };
    LoginComponent.prototype.signInByGuest = function () {
        var _this = this;
        if (!this.user.name) {
            this.usernameValidationResult = {
                status: 'error',
                comment: 'User name is empty',
                ok: false
            };
            return;
        }
        this.usernameValidationResult = this.validator.validateUsername(this.user.name);
        if (this.usernameValidationResult.status != 'success') {
            return;
        }
        this.apiClient.signInByGuest(this.user).subscribe(function (result) {
            _this.cookieService.putObject('auth_token', { token: result.token, expire: result.tokenExpire }, { expires: new Date(result.tokenExpire * 1000) });
            _this.router.navigate(['/main/chats/start-public-chat']);
        }, function (err) {
            _this.usernameValidationResult = {
                status: 'error',
                comment: JSON.stringify(err),
                ok: false
            };
        });
    };
    LoginComponent.prototype.goSignIn = function () {
        this.router.navigate(['/signin']);
    };
    LoginComponent.prototype.goSignUp = function () {
        this.router.navigate(['/signup']);
    };
    LoginComponent = __decorate([
        core_1.Component({
            selector: 'bongtalk-login',
            templateUrl: './templates/login.component.html',
            providers: [core_2.CookieService, validator_1.Validator]
        }), 
        __metadata('design:paramtypes', [router_1.Router, api_client_1.ApiClient, core_2.CookieService, validator_1.Validator])
    ], LoginComponent);
    return LoginComponent;
}());
exports.LoginComponent = LoginComponent;
var SignoutComponent = (function () {
    function SignoutComponent(router, cookieService, viewModel) {
        this.router = router;
        this.cookieService = cookieService;
        this.viewModel = viewModel;
    }
    SignoutComponent.prototype.ngOnInit = function () {
        this.cookieService.remove('auth_token');
        this.viewModel.unload();
        this.router.navigate(['/login']);
    };
    SignoutComponent = __decorate([
        core_1.Component({
            selector: 'bongtalk-signout',
            template: '',
            providers: [core_2.CookieService]
        }), 
        __metadata('design:paramtypes', [router_1.Router, core_2.CookieService, view_model_1.ViewModel])
    ], SignoutComponent);
    return SignoutComponent;
}());
exports.SignoutComponent = SignoutComponent;
var SigninComponent = (function () {
    function SigninComponent(router, apiClient, cookieService, validator) {
        this.router = router;
        this.apiClient = apiClient;
        this.cookieService = cookieService;
        this.validator = validator;
        this.user = new view_model_1.User();
        this.userIdValidationResult = new validator_1.ValidationResult();
        this.userPasswordValidationResult = new validator_1.ValidationResult();
        this.loginResult = '';
    }
    SigninComponent.prototype.userIdChanged = function (newValue) {
        this.user.id = newValue;
        this.userIdValidationResult = {
            status: this.user.id ? 'success' : '',
            comment: '',
            ok: true
        };
    };
    SigninComponent.prototype.passwordChanged = function (newValue) {
        this.user.password = newValue;
        this.userPasswordValidationResult = {
            status: this.user.password ? 'success' : '',
            comment: '',
            ok: true
        };
    };
    SigninComponent.prototype.inputKeypress = function ($event) {
        if ($event.keyCode == 13 && $event.key == 'Enter') {
            this.signIn();
        }
    };
    SigninComponent.prototype.signIn = function () {
        var _this = this;
        if (this.userIdValidationResult.status != 'success' || this.userPasswordValidationResult.status != 'success')
            return;
        this.loginResult = '';
        this.apiClient.signIn(this.user.id, this.user.password)
            .subscribe(function (result) {
            if (!result || !result.token) {
                _this.loginResult = 'error';
            }
            else {
                _this.loginResult = 'success';
                _this.cookieService.putObject('auth_token', { token: result.token, expire: result.tokenExpire }, { expires: new Date(result.tokenExpire * 1000) });
                _this.router.navigate(['/main/chats']);
            }
        }, function (error) { return _this.loginResult = 'error'; });
    };
    SigninComponent.prototype.back = function () {
        this.router.navigate(['/login']);
    };
    SigninComponent = __decorate([
        core_1.Component({
            selector: 'bongtalk-signin',
            templateUrl: './templates/signin.component.html',
            providers: [core_2.CookieService, validator_1.Validator]
        }), 
        __metadata('design:paramtypes', [router_1.Router, api_client_1.ApiClient, core_2.CookieService, validator_1.Validator])
    ], SigninComponent);
    return SigninComponent;
}());
exports.SigninComponent = SigninComponent;
var SignupComponent = (function () {
    function SignupComponent(router, apiClient, cookieService, validator) {
        this.router = router;
        this.apiClient = apiClient;
        this.cookieService = cookieService;
        this.validator = validator;
        this.user = new view_model_1.User();
        this.userIdValidationResult = new validator_1.ValidationResult();
        this.userPasswordValidationResult = new validator_1.ValidationResult();
    }
    SignupComponent.prototype.ngOnInit = function () {
        this.chageAvatarUrlRandom();
    };
    SignupComponent.prototype.userIdChanged = function (newValue) {
        var _this = this;
        this.user.id = newValue;
        this.userIdValidationResult = this.validator.validateUserId(newValue);
        if (this.userIdValidationResult.ok) {
            this.apiClient.checkUserExist(this.user.id)
                .subscribe(function (result) { return _this.userIdValidationResult = result ? {
                status: 'error',
                comment: 'Aleady exists.',
                ok: false
            } : {
                status: 'success',
                comment: '',
                ok: true
            }; }, function (err) { return _this.userIdValidationResult = {
                status: 'success',
                comment: '',
                ok: true
            }; });
        }
    };
    SignupComponent.prototype.passwordChanged = function (newValue) {
        this.user.password = newValue;
        this.userPasswordValidationResult = this.validator.validatePassword(this.user.password);
    };
    SignupComponent.prototype.chageAvatarUrlRandom = function () {
        var _this = this;
        this.apiClient.getRandomAvatarUrl().subscribe(function (result) { return _this.avatarUrl = result; });
    };
    SignupComponent.prototype.back = function () {
        this.router.navigate(['/login']);
    };
    SignupComponent.prototype.inputKeypress = function ($event) {
        if ($event.keyCode == 13 && $event.key == 'Enter') {
            this.signUp();
        }
    };
    SignupComponent.prototype.signUp = function () {
        var _this = this;
        if (!this.validator.validateUserId(this.user.id) || !this.validator.validatePassword(this.user.password))
            return;
        this.apiClient.signUp(this.user)
            .subscribe(function (result) {
            // signin
            if (result && result.result && result.result.ok) {
                _this.apiClient.signIn(_this.user.id, _this.user.password)
                    .subscribe(function (result) {
                    if (!result.token) {
                        alert('Empty token.');
                        return;
                    }
                    _this.cookieService.putObject('auth_token', { token: result.token, expire: result.tokenExpire }, { expires: new Date(result.tokenExpire * 1000) });
                    _this.router.navigate(['/main/chats/set-username/first']);
                });
            }
            else {
                alert('Bad response.');
            }
        }, function (err) {
            alert(JSON.stringify(err));
        });
    };
    SignupComponent = __decorate([
        core_1.Component({
            selector: 'bongtalk-signup',
            templateUrl: './templates/signup.component.html',
            providers: [core_2.CookieService, validator_1.Validator],
            pipes: [pipes_1.AutoProxyPipe]
        }), 
        __metadata('design:paramtypes', [router_1.Router, api_client_1.ApiClient, core_2.CookieService, validator_1.Validator])
    ], SignupComponent);
    return SignupComponent;
}());
exports.SignupComponent = SignupComponent;
//# sourceMappingURL=login.component.js.map