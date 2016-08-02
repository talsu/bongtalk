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
var router_1 = require('@angular/router');
var core_2 = require('angular2-cookie/core');
var view_model_1 = require('./view-model');
var Observable_1 = require('rxjs/Observable');
var BootComponent = (function () {
    function BootComponent(apiClient, router, cookieService, viewModel) {
        this.apiClient = apiClient;
        this.router = router;
        this.cookieService = cookieService;
        this.viewModel = viewModel;
    }
    BootComponent.prototype.ngOnInit = function () {
        var _this = this;
        this.checkLogin().subscribe(function (result) {
            console.log(result);
            _this.viewModel.me = result;
            _this.router.navigate(['/main']);
        }, function (error) {
            console.log(error);
            _this.router.navigate(['/login']);
        });
        // this.apiClient.getMyInfo()
        // .subscribe(
        //     result => console.log(result),
        //     err => this.router.navigate(['/login'])
        // );
    };
    BootComponent.prototype.checkLogin = function () {
        var _this = this;
        var authToken = this.cookieService.getObject('auth_token');
        if (authToken) {
            if (this.viewModel.me) {
                return Observable_1.Observable.create(function (observer) {
                    observer.next(_this.viewModel.me);
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
        //
        // return Observable.create(observer => {
        //     let authToken = this.cookieService.getObject('auth_token');
        //     if (authToken) {
        //         if (this.viewModel.me){
        //             observer.onNext(this.viewModel.me);
        //             observer.onCompleted();
        //         }
        //         else {
        //             this.apiClient.getMyInfo()
        //                 .subscribe(
        //                     result => observer.onNext(result),
        //                     err => observer.onError('not login'),
        //                     () => observer.onCompleted()
        //                 );
        //         }
        //     }
        //     else {
        //          observer.onError('not login');
        //          observer.onCompleted();
        //     }
        // });
        // let authToken = this.cookieService.getObject('auth_token');
        // if (authToken) {
        //     if (this.viewModel.me){
        //         // ok
        //     }
        //     else {
        //         this.apiClient.getMyInfo()
        //             .subscribe(
        //                 result => console.log(result),
        //                 err => this.router.navigate(['/login'])
        //             );
        //     }
        // }
        // else {
        //     this.router.navigate(['/login'])
        // }
    };
    BootComponent = __decorate([
        core_1.Component({
            selector: 'boot',
            template: '',
            providers: [core_2.CookieService]
        }), 
        __metadata('design:paramtypes', [api_client_1.ApiClient, router_1.Router, core_2.CookieService, view_model_1.ViewModel])
    ], BootComponent);
    return BootComponent;
}());
exports.BootComponent = BootComponent;
//# sourceMappingURL=boot.component.js.map