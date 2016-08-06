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
var api_client_1 = require('./api-client');
var core_2 = require('angular2-cookie/core');
var Observable_1 = require('rxjs/Observable');
var User = (function () {
    function User() {
    }
    return User;
}());
exports.User = User;
var ViewModel = (function () {
    function ViewModel(apiClient, cookieService) {
        this.apiClient = apiClient;
        this.cookieService = cookieService;
        console.log('view model created.');
    }
    ViewModel.prototype.unload = function () {
        this.me = null;
    };
    ;
    ViewModel.prototype.checkLogin = function () {
        var _this = this;
        var authToken = this.cookieService.getObject('auth_token');
        if (authToken) {
            if (this.me) {
                return Observable_1.Observable.create(function (observer) {
                    observer.next(_this.me);
                    observer.complete();
                });
            }
            else {
                return this.apiClient.getMyInfo();
            }
        }
        else {
            return Observable_1.Observable.throw('not login');
        }
    };
    ViewModel = __decorate([
        core_1.Injectable(), 
        __metadata('design:paramtypes', [api_client_1.ApiClient, core_2.CookieService])
    ], ViewModel);
    return ViewModel;
}());
exports.ViewModel = ViewModel;
// export const VIEW_MODEL
//# sourceMappingURL=view-model.js.map