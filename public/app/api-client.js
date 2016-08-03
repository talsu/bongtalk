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
var http_1 = require('@angular/http');
var core_1 = require('@angular/core');
var Observable_1 = require('rxjs/Observable');
var ApiClient = (function () {
    function ApiClient(http) {
        this.http = http;
        console.log('api client created');
    }
    ApiClient.prototype.checkUserExist = function (userId) {
        return this.httpGet('api/checkUserExist', { userId: userId });
    };
    ApiClient.prototype.signIn = function (userId, password) {
        return this.httpPost('api/signIn', { userId: userId, password: password });
    };
    ApiClient.prototype.signInByGuest = function (user) {
        return this.httpPost('api/signInByGuest', { user: user });
    };
    ApiClient.prototype.signUp = function (user) {
        return this.httpPost('api/signUp', { user: user });
    };
    ApiClient.prototype.getQufoxUrl = function () {
        return this.httpGet("api/qufox");
    };
    ApiClient.prototype.refreshToken = function () {
        return this.httpGet("api/refreshToken");
    };
    ApiClient.prototype.getMyInfo = function () {
        return this.httpGet("api/user");
    };
    ApiClient.prototype.getRandomAvatarUrl = function () {
        return this.httpGet('api/avatars/random');
    };
    ApiClient.prototype.httpGet = function (url, paramObj) {
        if (paramObj === void 0) { paramObj = null; }
        if (paramObj) {
            var params = new http_1.URLSearchParams();
            for (var name in paramObj) {
                params.set(name, paramObj[name]);
            }
            return this.http.get(url, { search: params })
                .map(this.extractData)
                .catch(this.handleError);
        }
        else {
            return this.http.get(url)
                .map(this.extractData)
                .catch(this.handleError);
        }
    };
    ApiClient.prototype.httpPost = function (url, data) {
        var headers = new http_1.Headers({ 'Content-Type': 'application/json' });
        return this.http.post(url, JSON.stringify(data), { headers: headers })
            .map(this.extractData)
            .catch(this.handleError);
    };
    ApiClient.prototype.extractData = function (res) {
        var body = res.json();
        if (body.err)
            throw { message: body.err };
        return body.result || {};
    };
    ApiClient.prototype.handleError = function (error) {
        // In a real world app, we might use a remote logging infrastructure
        // We'd also dig deeper into the error to get a better message
        var errMsg = (error.message) ? error.message :
            error.status ? error.status + " - " + error.statusText : 'Server error';
        console.error(errMsg); // log to console instead
        return Observable_1.Observable.throw(errMsg);
    };
    ApiClient = __decorate([
        core_1.Injectable(), 
        __metadata('design:paramtypes', [http_1.Http])
    ], ApiClient);
    return ApiClient;
}());
exports.ApiClient = ApiClient;
//# sourceMappingURL=api-client.js.map