


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

