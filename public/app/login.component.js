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
var User = (function () {
    function User() {
    }
    return User;
}());
var LoginComponent = (function () {
    function LoginComponent(router, apiClient) {
        this.router = router;
        this.apiClient = apiClient;
        this.user = new User();
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
        this.apiClient.signInByGuest(this.user).subscribe(function (result) { return console.log(result); }, function (err) { return console.log(err); });
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
            templateUrl: './app/login.component.html'
        }), 
        __metadata('design:paramtypes', [router_1.Router, api_client_1.ApiClient])
    ], LoginComponent);
    return LoginComponent;
}());
exports.LoginComponent = LoginComponent;
//# sourceMappingURL=login.component.js.map