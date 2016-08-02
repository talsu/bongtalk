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
var view_model_1 = require('./view-model');
var BootComponent = (function () {
    function BootComponent(router, viewModel) {
        this.router = router;
        this.viewModel = viewModel;
    }
    BootComponent.prototype.ngOnInit = function () {
        var _this = this;
        this.viewModel.checkLogin().subscribe(function (result) {
            _this.viewModel.me = result;
            _this.router.navigate(['/main']);
        }, function (error) {
            console.log(error);
            _this.router.navigate(['/login']);
        });
    };
    BootComponent = __decorate([
        core_1.Component({
            selector: 'boot',
            template: ''
        }), 
        __metadata('design:paramtypes', [router_1.Router, view_model_1.ViewModel])
    ], BootComponent);
    return BootComponent;
}());
exports.BootComponent = BootComponent;
//# sourceMappingURL=boot.component.js.map