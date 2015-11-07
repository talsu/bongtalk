'use strict';


bongtalkControllers.controller('LoginController',  ['$scope', '$location', '$http', 'ngDialog', 'emitter',
function($scope, $location, $http, ngDialog, emitter) {

}]);

bongtalkControllers.controller('SignOutController',  ['$scope', '$location', '$cookies', 'ngDialog', 'emitter',
function($scope, $location, $cookies, ngDialog, emitter) {
	$cookies.remove('auth_token');
	$scope.vm.unload();
	$location.path("/login");
}]);

bongtalkControllers.controller('LoginDialogController',  ['$scope', '$location', '$routeParams', '$cookies', 'ngDialog', 'apiClient', 'validator',
function($scope, $location, $routeParams, $cookies, ngDialog, apiClient, validator) {

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

		apiClient.signInByGuest($scope.user.name, function (err, result) {
			if (err) {
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = JSON.stringify(err);
			}
			else {
				$cookies.putObject('auth_token', {token:result.token, expire:result.tokenExpire}, {expires:new Date(result.tokenExpire*1000)});
				$location.path('/main/chats/start-public-chat');
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

bongtalkControllers.controller('SignInDialogController',  ['$scope', '$location', '$routeParams', '$cookies', 'ngDialog', 'apiClient', 'emitter',
function($scope, $location, $routeParams, $cookies, ngDialog, apiClient, emitter) {
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
		apiClient.signIn($scope.userId, $scope.password, function (err, result) {
			if (err || !result || !result.token) {
				$scope.loginResult = 'error';
			}
			else {
				$scope.loginResult = 'success';
				$cookies.putObject('auth_token', {token:result.token, expire:result.tokenExpire}, {expires:new Date(result.tokenExpire*1000)});
				$location.path('/main/chats');
			}
		});
	};

	$scope.back = function () {
		$location.path('/login');
	};
}]);


bongtalkControllers.controller('SignUpDialogController',  ['$scope', '$location', '$routeParams', '$cookies', 'ngDialog', 'apiClient', 'validator',
function($scope, $location, $routeParams, $cookies, ngDialog, apiClient, validator) {

	$scope.userIdValidationStatus = '';
	$scope.userIdValidationComment = '';

	$scope.userIdChanged = function () {
		var validateResult = validator.validateUserId($scope.userId);

		if (validateResult.ok) {
			apiClient.checkUserExist($scope.userId, function (err, result) {
				if (result) {
					$scope.userIdValidationStatus = 'error';
					$scope.userIdValidationComment = 'Aleady exists.';
				}
				else {
					$scope.userIdValidationStatus = 'success';
					$scope.userIdValidationComment = '';
				}
			});
		} else {
			$scope.userIdValidationStatus = validateResult.status;
			$scope.userIdValidationComment = validateResult.comment;
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

		apiClient.signUp($scope.userId, $scope.password, function (err, result) {
			if (commonResponseHandle(err, result)) return;

			// signin
			if (result && result.result && result.result.ok){
				apiClient.signIn($scope.userId, $scope.password, function (err, result) {
					if (commonResponseHandle(err, result)) return;

					if (!result.token) {
						alert('Empty token.');
						return;
					}

					$cookies.putObject('auth_token', {token:result.token, expire:result.tokenExpire}, {expires:new Date(result.tokenExpire*1000)});
					$location.path('/main/chats/set-username/first');
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

function commonResponseHandle(err, result) {
	if (!result) {
		alert('Empty response.');
		return true;
	}

	if (err) {
		alert(err);
		return true;
	}
}
