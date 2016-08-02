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
var LoginComponent = (function () {
    function LoginComponent(router, apiClient, cookieService) {
        this.router = router;
        this.apiClient = apiClient;
        this.cookieService = cookieService;
        this.user = new view_model_1.User();
    }
    LoginComponent.prototype.usernameChanged = function (newValue) {
        console.log(newValue);
        this.user.name = newValue;
    };
    LoginComponent.prototype.usernameKeypress = function ($event) {
        if ($event.keyCode == 13 && $event.key == 'Enter') {
            this.signInByGuest();
        }
    };
    LoginComponent.prototype.signInByGuest = function () {
        var _this = this;
        this.apiClient.signInByGuest(this.user).subscribe(function (result) {
            _this.cookieService.putObject('auth_token', { token: result.token, expire: result.tokenExpire }, { expires: new Date(result.tokenExpire * 1000) });
            _this.router.navigate(['/main/chats/start-public-chat']);
        }, function (err) { return console.log(err); });
    };
    LoginComponent.prototype.goSignIn = function () {
        this.router.navigate(['/signin']);
    };
    LoginComponent.prototype.goSignUp = function () {
        this.router.navigate(['/signup']);
    };
    LoginComponent = __decorate([
        core_1.Component({
            selector: 'bongtalk-app',
            templateUrl: './app/login.component.html',
            providers: [core_2.CookieService]
        }), 
        __metadata('design:paramtypes', [router_1.Router, api_client_1.ApiClient, core_2.CookieService])
    ], LoginComponent);
    return LoginComponent;
}());
exports.LoginComponent = LoginComponent;
//# sourceMappingURL=login.component.js.map