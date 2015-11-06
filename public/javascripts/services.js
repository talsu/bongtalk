


// service
bongtalkControllers.factory('bongtalk', [function () {
        return Bongtalk(window.location.protocol + '//' + window.location.host);
    }]);

// service
bongtalkControllers.factory('apiClient', ['$http', function ($http) {
        return BongtalkClient2($http);
    }]);

bongtalkControllers.factory('bongtalkAutoRefreshToken', ['$cookies', 'bongtalk', function ($cookies, bongtalk) {
        var BongtalkAutoRefreshTokenService = (function () {
            function BongtalkAutoRefreshTokenService() {
                var self = this;
                self.timeoutTask = null;
            }

            BongtalkAutoRefreshTokenService.prototype.start = function () {
                var self = this;
                if (bongtalk && bongtalk.token && bongtalk.tokenExpire) {

                    var remainSec = bongtalk.tokenExpire - Math.floor(Date.now() / 1000);
                    if (remainSec < 30) {
                        bongtalk.refreshToken(function (res) {
                            if (res && !res.err && res.result) {
                                $cookies.putObject('auth_token', { token: res.result.token, expire: res.result.tokenExpire }, { expires: new Date(res.result.tokenExpire * 1000) });
                                self.start();
                            }
                        });
                    }
                    else {
                        self.timeoutTask = setTimeout(function () {
                            bongtalk.refreshToken(function (res) {
                                if (res && !res.err && res.result) {
                                    $cookies.putObject('auth_token', { token: res.result.token, expire: res.result.tokenExpire }, { expires: new Date(res.result.tokenExpire * 1000) });
                                    self.start();
                                }
                            });
                        }, (remainSec - 20) * 1000)
                    }
                }
            }

            BongtalkAutoRefreshTokenService.prototype.stop = function () {
                var self = this;
                if (self.timeoutTask) {
                    clearTimeout(self.timeoutTask);
                    self.timeoutTask = null;
                }
            };

            return BongtalkAutoRefreshTokenService;
        })();

        return new BongtalkAutoRefreshTokenService();
    }]);

bongtalkControllers.factory('emitter', [function () {
        return new EventEmitter();
    }]);


    bongtalkControllers.factory('validator', [function(){

    	var Validator = (function() {
    		function Validator() { }

    		Validator.prototype.validateUserName = function (userName) {
    			var result = {
    				status:'',
    				comment:'',
    				ok:false,
    			}

    			if (!userName) {
    				result.status = '';
    				result.comment = '';
    			} else if (userName.length < 2) {
    				result.status = 'error';
    				result.comment = 'Username is too short.';
    			} else if (userName.length > 20) {
    				result.status = 'error';
    				result.comment = 'Username is too long.';
    			} else {
    				result.status = 'success';
    				result.comment = '';
    				result.ok = true;
    			}

    			return result;
    		};

    		Validator.prototype.validateUserId = function (userId) {
    			var result = {
    				status:'',
    				comment:'',
    				ok:false,
    			}

    			if (!userId) {
    				result.status = '';
    				result.comment = '';
    			} else if (userId.length < 4) {
    				result.status = 'error';
    				result.comment = 'User ID is too short.';
    			} else if (userId.length > 20) {
    				result.status = 'error';
    				result.comment = 'User ID is too long.';
    			} else if (/\s/g.test(userId)){
    				result.status = 'error';
    				result.comment = 'User ID has white space.';
    			} else {
    				result.status = 'success';
    				result.comment = '';
    				result.ok = true;
    			}

    			return result;
    		};

    		Validator.prototype.validatePassword = function (password) {
    			var result = {
    				status:'',
    				comment:'',
    				ok:false,
    			}

    			if (!password) {
    				result.status = '';
    				result.comment = '';
    			} else if (password.length < 4) {
    				result.status = 'error';
    				result.comment = 'Password is too short.';
    			} else if (password.length > 20) {
    				result.status = 'error';
    				result.comment = 'Password is too long.';
    			} else if (/\s/g.test(password)){
    				result.status = 'error';
    				result.comment = 'Password Has white space.';
    			} else {
    				result.status = 'success';
    				result.comment = '';
    				result.ok = true;
    			}

    			return result;
    		};

    		Validator.prototype.validateSessionName = function (sessionName) {
    			var result = {
    				status:'',
    				comment:'',
    				ok:false,
    			}

    			if (!sessionName) {
    				result.status = 'error';
    				result.comment = 'Chat name is empty.';
    			} else if (sessionName.length < 2) {
    				result.status = 'error';
    				result.comment = 'Chat name is too short.';
    			} else if (sessionName.length > 20) {
    				result.status = 'error';
    				result.comment = 'Chat name is too long.';
    			} else {
    				result.status = 'success';
    				result.comment = '';
    				result.ok = true;
    			}

    			return result;
    		};

    		return Validator;
    	})();

    	return new Validator();
    }]);
