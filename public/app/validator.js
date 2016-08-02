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
var ValidationResult = (function () {
    function ValidationResult() {
    }
    return ValidationResult;
}());
exports.ValidationResult = ValidationResult;
var Validator = (function () {
    function Validator() {
    }
    Validator.prototype.validateUsername = function (username) {
        var result = new ValidationResult();
        if (!username) {
            result.status = '';
            result.comment = '';
        }
        else if (username.length < 2) {
            result.status = 'error';
            result.comment = 'Username is too short.';
        }
        else if (username.length > 20) {
            result.status = 'error';
            result.comment = 'Username is too long.';
        }
        else if (/\s/g.test(username)) {
            result.status = 'error';
            result.comment = 'Username has white space.';
        }
        else {
            result.status = 'success';
            result.comment = '';
            result.ok = true;
        }
        return result;
    };
    Validator.prototype.validateUserId = function (userId) {
        var result = new ValidationResult();
        if (!userId) {
            result.status = '';
            result.comment = '';
        }
        else if (userId.length < 4) {
            result.status = 'error';
            result.comment = 'User ID is too short.';
        }
        else if (userId.length > 20) {
            result.status = 'error';
            result.comment = 'User ID is too long.';
        }
        else if (/\s/g.test(userId)) {
            result.status = 'error';
            result.comment = 'User ID has white space.';
        }
        else {
            result.status = 'success';
            result.comment = '';
            result.ok = true;
        }
        return result;
    };
    Validator.prototype.validatePassword = function (password) {
        var result = new ValidationResult();
        if (!password) {
            result.status = '';
            result.comment = '';
        }
        else if (password.length < 4) {
            result.status = 'error';
            result.comment = 'Password is too short.';
        }
        else if (password.length > 20) {
            result.status = 'error';
            result.comment = 'Password is too long.';
        }
        else if (/\s/g.test(password)) {
            result.status = 'error';
            result.comment = 'Password Has white space.';
        }
        else {
            result.status = 'success';
            result.comment = '';
            result.ok = true;
        }
        return result;
    };
    Validator.prototype.validateSessionName = function (sessionName) {
        var result = new ValidationResult();
        if (!sessionName) {
            result.status = 'error';
            result.comment = 'Session name is empty.';
        }
        else if (sessionName.length < 2) {
            result.status = 'error';
            result.comment = 'Session name is too short.';
        }
        else if (sessionName.length > 20) {
            result.status = 'error';
            result.comment = 'Session name is too long.';
        }
        else {
            result.status = 'success';
            result.comment = '';
            result.ok = true;
        }
        return result;
    };
    Validator.prototype.validateSessionType = function (sessionType, users) {
        var result = new ValidationResult();
        if (!sessionType) {
            result.status = 'error';
            result.comment = 'Session type is empty.';
        }
        else if (!Array.isArray(users)) {
            result.status = 'error';
            result.comment = 'users is not Array type.';
        }
        else if (['public', 'group', 'personal'].indexOf(sessionType) == -1) {
            result.status = 'error';
            result.comment = 'Invalid session type : ' + sessionType;
        }
        else if (sessionType == 'public' && users.length === 0) {
            result.status = 'error';
            result.comment = 'public session need user.';
        }
        else if (sessionType == 'group' && users.length === 0) {
            result.status = 'error';
            result.comment = 'group session need user.';
        }
        else if (sessionType == 'personal' && (users.length != 2 || users[0] == users[1])) {
            result.status = 'error';
            result.comment = 'personal session need two user.';
        }
        else {
            result.status = 'success';
            result.comment = '';
            result.ok = true;
        }
        return result;
    };
    Validator = __decorate([
        core_1.Injectable(), 
        __metadata('design:paramtypes', [])
    ], Validator);
    return Validator;
}());
exports.Validator = Validator;
//# sourceMappingURL=validator.js.map