'use strict';


bongtalkControllers.controller('LoginController',  ['$scope', '$location', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $http, ngDialog, bongtalk, emitter) {

	}]);

bongtalkControllers.controller('SignOutController',  ['$scope', '$location', '$cookies', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $cookies, ngDialog, bongtalk, emitter) {
		$cookies.remove('auth_token');
		$scope.vm.unload();
		$location.path("/login");
	}]);

bongtalkControllers.controller('LoginDialogController',  ['$scope', '$location', '$routeParams', '$cookies', 'ngDialog', 'bongtalk', 'validator',
	function($scope, $location, $routeParams, $cookies, ngDialog, bongtalk, validator) {

		$scope.user = {};
		$scope.currentUserName = '';
		$scope.userNameChanged = function () {
			var result = validator.validateUserName($scope.user.name);
			$scope.userNameValidationStatus = result.status;
			$scope.userNameValidationComment = result.comment;
		};

		$scope.signInByGuest = function () {
			if (!$scope.user.name) {
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = 'User name is empty';
				return;
			}

			var result = validator.validateUserName($scope.user.name);
			if (result.status != 'success') {
				$scope.userNameValidationStatus = result.status;
				$scope.userNameValidationComment = result.comment;
				return;
			}

			bongtalk.signInByGuest($scope.user.name, function (res) {
				if (res.err) {
					$scope.$apply(function () {
						$scope.userNameValidationStatus = 'error';
						$scope.userNameValidationComment = JSON.stringify(res.err);
					});
				}
				else {
					$cookies.putObject('auth_token', {token:res.result.token, expire:res.result.tokenExpire}, {expires:new Date(res.result.tokenExpire*1000)});
					$scope.$apply(function() {
						$location.path('/main/chats/start-public-chat');
					});
				}
			});
		};
		$scope.openSignIn = function () {
			$location.path("/signin");
		};

		$scope.openSignUp = function () {
			$location.path("/signup");
		};
	}]);

bongtalkControllers.controller('SignInDialogController',  ['$scope', '$location', '$routeParams', '$cookies', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $routeParams, $cookies, ngDialog, bongtalk, emitter) {
		$scope.loginResult = '';
		$scope.userIdValidationStatus = '';
		$scope.userIdValidationComment = '';


		$scope.userIdChanged = function () {
			if (!$scope.userId) {
				$scope.userIdValidationStatus = '';
				$scope.userIdValidationComment = '';
			} else {
				$scope.userIdValidationStatus = 'success';
				$scope.userIdValidationComment = '';
			}
		};

		$scope.passwordValidationStatus = '';
		$scope.passwordValidationComment = '';

		$scope.passwordChanged = function () {
			if (!$scope.password) {
				$scope.passwordValidationStatus = '';
				$scope.passwordValidationComment = '';
			} else {
				$scope.passwordValidationStatus = 'success';
				$scope.passwordValidationComment = '';
			}
		};

		$scope.signIn = function () {
			if ($scope.userIdValidationStatus != 'success' || $scope.passwordValidationStatus != 'success')	return;
			$scope.loginResult = '';
			bongtalk.signIn($scope.userId, $scope.password, function (res) {
				if (!res || res.err || !res.result || !res.result.token) {
					$scope.$apply(function () { $scope.loginResult = 'error'; });
				}
				else {
					$scope.$apply(function () {
						$scope.loginResult = 'success';
						$cookies.putObject('auth_token', {token:res.result.token, expire:res.result.tokenExpire}, {expires:new Date(res.result.tokenExpire*1000)});
						$location.path('/main/chats');
					});
				}
			});
		};

		$scope.back = function () {
			$location.path('/login');
		};
	}]);


bongtalkControllers.controller('SignUpDialogController',  ['$scope', '$location', '$routeParams', '$cookies', 'ngDialog', 'bongtalk', 'validator',
	function($scope, $location, $routeParams, $cookies, ngDialog, bongtalk, validator) {

		$scope.userIdValidationStatus = '';
		$scope.userIdValidationComment = '';

		$scope.userIdChanged = function () {
			var result = validator.validateUserId($scope.userId);

			if (result.ok) {
				bongtalk.checkUserExist($scope.userId, function (res) {
					$scope.$apply(function (){
						if (res.result) {
							$scope.userIdValidationStatus = 'error';
							$scope.userIdValidationComment = 'Aleady exists.';
						}
						else {
							$scope.userIdValidationStatus = 'success';
							$scope.userIdValidationComment = '';
						}
					});
				});
			} else {
				$scope.userIdValidationStatus = result.status;
				$scope.userIdValidationComment = result.comment;
			}
		};

		$scope.passwordValidationStatus = '';
		$scope.passwordValidationComment = '';

		$scope.passwordChanged = function () {
			var result = validator.validatePassword($scope.password);
			$scope.passwordValidationStatus = result.status;
			$scope.passwordValidationComment = result.comment;
		};

		$scope.signUp = function () {
			if (!validator.validateUserId($scope.userId) || !validator.validatePassword($scope.password)) return;

			bongtalk.signUp($scope.userId, $scope.password, function (res) {
				if (commonResponseHandle(res)) return;

				// signin
				if (res.result && res.result.result && res.result.result.ok){
					bongtalk.signIn($scope.userId, $scope.password, function (res) {
						if (commonResponseHandle(res)) return;

						if (!res.result.token) {
							alert('Empty token.');
							return;
						}

						$scope.$apply(function () {
							$cookies.putObject('auth_token', {token:res.result.token, expire:res.result.tokenExpire}, {expires:new Date(res.result.tokenExpire*1000)});
							$location.path('/main/chats/set-username/first');
						});

					});
				}
				else {
					alert('Bad response.');
					return;
				}
			});
		};

		$scope.back = function () {
			$location.path('/login');
		};
	}]);

function commonResponseHandle(res) {
	if (!res) {
		alert('Empty response.');
		return true;
	}

	if (res.err) {
		alert(res.err);
		return true;
	}
}
