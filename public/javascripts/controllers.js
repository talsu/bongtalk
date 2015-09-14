'use strict';

/* Controllers */

var bongtalkControllers = angular.module('bongtalk.controllers', []);

bongtalkControllers.controller('BootController', ['$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $routeParams, $cookies, $location, ngDialog, bongtalk, emitter) {		
		var authToken = $cookies.getObject('auth_token');
		if (authToken) {
			bongtalk.signInRecover(authToken, function (res) {
				$scope.$apply(function (){
					if (res && !res.err && res.result) {
						$location.path('/main/chats');
					}
					else {
						$location.path('/login');
					}
				});
			});
		}
		else {
			$location.path('/login');
		}
	}]);

bongtalkControllers.controller('MainController', ['$window', '$rootScope', '$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalk', 'bongtalkAutoRefreshToken', 'emitter',
	function($window, $rootScope, $scope, $routeParams, $cookies, $location, ngDialog, bongtalk, bongtalkAutoRefreshToken, emitter) {		
		$scope.routeLeft = $routeParams.left || 'chats';
		$scope.routeRight = $routeParams.right;		
		$scope.routeParam = $routeParams.param;

		$scope.isRightMain = ($routeParams.right && $routeParams.right != 'none');

		var authToken = $cookies.getObject('auth_token');
		if (authToken) {
			bongtalk.signInRecover(authToken, function (res) {
				$scope.$apply(function (){
					if (res && !res.err && res.result) {
						init();
					}
					else {
						$location.path('/login');
					}
				});
			});
		}
		else {
			$location.path('/login');
		}

		function init() {
			bongtalk.startSync();
			bongtalkAutoRefreshToken.start();
			emitter.on('focusArea', onFocusArea);

			$scope.$on('$destroy', function () {
				bongtalk.stopSync();
				bongtalkAutoRefreshToken.stop();
				emitter.off('focusArea', onFocusArea);
			});
		}

		function onFocusArea (isRight) {
			$scope.isRightMain = isRight;
		}
	}]);

bongtalkControllers.controller('ConnectionStatusController', ['$scope', '$routeParams', '$http', 'bongtalk', 'emitter',
	function($scope, $routeParams, $http, bongtalk, emitter) {

		$scope.serverStatus = bongtalk.qufox.status;

		bongtalk.qufox.onStatusChanged(serverStatusChanged);
		function serverStatusChanged (status){			
			$scope.$apply(function(){
				$scope.serverStatus = status;
			});
		};
	}]);





// service
bongtalkControllers.factory('bongtalk', [function(){
	return Bongtalk(window.location.protocol + '//' + window.location.host);
}]);

bongtalkControllers.factory('bongtalkAutoRefreshToken', ['$cookies', 'bongtalk', function ($cookies, bongtalk) {
	var BongtalkAutoRefreshTokenService = (function () {
		function BongtalkAutoRefreshTokenService(){
			var self = this;
			self.timeoutTask = null;
		}

		BongtalkAutoRefreshTokenService.prototype.start = function() {
			var self = this;
			if (bongtalk && bongtalk.token && bongtalk.tokenExpire) {

				var remainSec = bongtalk.tokenExpire - Math.floor(Date.now() / 1000);
    			if (remainSec < 30) {
    				bongtalk.refreshToken(function (res){
    					if (res && !res.err && res.result) {
    						$cookies.putObject('auth_token', {token:res.result.token, expire:res.result.tokenExpire}, {expires:new Date(res.result.tokenExpire*1000)});
    						self.start();
    					}
    				});
    			}
    			else {
    				self.timeoutTask = setTimeout(function () {
    					bongtalk.refreshToken(function (res){
	    					if (res && !res.err && res.result) {
	    						$cookies.putObject('auth_token', {token:res.result.token, expire:res.result.tokenExpire}, {expires:new Date(res.result.tokenExpire*1000)});
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

bongtalkControllers.factory('emitter', [function(){
	return new EventEmitter();
}]);

