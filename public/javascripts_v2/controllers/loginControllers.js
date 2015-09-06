'use strict';


bongtalkControllers.controller('LoginController',  ['$scope', '$location', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $http, ngDialog, bongtalk, emitter) {

	}]);

bongtalkControllers.controller('SignOutController',  ['$scope', '$location', '$cookies', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $cookies, ngDialog, bongtalk, emitter) {
		$cookies.remove('auth_token');
		$location.path("/login");
	}]);

bongtalkControllers.controller('LoginDialogController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, emitter) {
		//$scope.closeThisDialog();
		$scope.noAccount = function () {			
			
		};
		$scope.openSignIn = function () {
			$location.path("/signin");
		};

		$scope.openSignUp = function () {
			$location.path("/signup");		
			// $scope.closeThisDialog();
			// ngDialog.open({
			// 	template:'/partials_v2/signUpDialog.html',
			// 	className: 'ngdialog-theme-default login_dialog',
			// 	controller: 'SignUpDialogController',
			// 	closeByDocument: false,
			// 	closeByEscape: false,
			// 	showClose: false
			// });	
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
			// } else if ($scope.userId.length < 4) {
			// 	$scope.userIdValidationStatus = 'error';
			// 	$scope.userIdValidationComment = 'Too short.';
			// } else if ($scope.userId.length > 20) {
			// 	$scope.userIdValidationStatus = 'error';
			// 	$scope.userIdValidationComment = 'Too long.';
			// } else if (/\s/g.test($scope.userId)){
			// 	$scope.userIdValidationStatus = 'error';
			// 	$scope.userIdValidationComment = 'Has white space.';
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
			// } else if ($scope.password.length < 4) {
			// 	$scope.passwordValidationStatus = 'error';
			// 	$scope.passwordValidationComment = 'Too short.';
			// } else if ($scope.password.length > 20) {
			// 	$scope.passwordValidationStatus = 'error';
			// 	$scope.passwordValidationComment = 'Too long.';
			// } else if (/\s/g.test($scope.password)){
			// 	$scope.passwordValidationStatus = 'error';
			// 	$scope.passwordValidationComment = 'Has white space.';
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


bongtalkControllers.controller('SetUsernameInDialogController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, emitter) {
		$scope.userNameValidationStatus = '';
		$scope.userNameValidationComment = '';
		$scope.currentUserName = '';
		$scope.userNameChanged = function () {
			if (!$scope.userName) {
				$scope.userNameValidationStatus = '';
				$scope.userNameValidationComment = '';
			} else if ($scope.userName.length < 4) {
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = 'Too short.';
			} else if ($scope.userName.length > 20) {
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = 'Too long.';
			} else if (/\s/g.test($scope.userName)){
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = 'Has white space.';
			} else {
				$scope.userNameValidationStatus = 'success';
				$scope.userNameValidationComment = '';
			}
		};

		$scope.setUsername = function () {
			bongtalk.setMyInfo({name:$scope.userName}, function (res){
				if (res.err) {alert(err); return;}
				if (res.result.ok) {					
					$scope.closeThisDialog();
				}
			});
		}

		$scope.close = function () {
			$scope.closeThisDialog();
		};

		bongtalk.getMyInfo(function (res) {
			commonResponseHandle(res);

			if (res.result && res.result.name && $scope.currentUserName != res.result.name){
				$scope.$apply(function () {
					$scope.currentUserName = res.result.name;
				});
			}
		});
	}]);

bongtalkControllers.controller('SignUpDialogController',  ['$scope', '$location', '$routeParams', '$cookies', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $routeParams, $cookies, ngDialog, bongtalk, emitter) {

		$scope.userIdValidationStatus = '';
		$scope.userIdValidationComment = '';

		$scope.userIdChanged = function () {
			if (!$scope.userId) {
				$scope.userIdValidationStatus = '';
				$scope.userIdValidationComment = '';
			} else if ($scope.userId.length < 4) {
				$scope.userIdValidationStatus = 'error';
				$scope.userIdValidationComment = 'Too short.';
			} else if ($scope.userId.length > 20) {
				$scope.userIdValidationStatus = 'error';
				$scope.userIdValidationComment = 'Too long.';
			} else if (/\s/g.test($scope.userId)){
				$scope.userIdValidationStatus = 'error';
				$scope.userIdValidationComment = 'Has white space.';
			} else {
				$scope.userIdValidationStatus = 'warning';
				$scope.userIdValidationComment = '';
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
			}
		};

		$scope.passwordValidationStatus = '';
		$scope.passwordValidationComment = '';

		$scope.passwordChanged = function () {
			if (!$scope.password) {
				$scope.passwordValidationStatus = '';
				$scope.passwordValidationComment = '';
			} else if ($scope.password.length < 4) {
				$scope.passwordValidationStatus = 'error';
				$scope.passwordValidationComment = 'Too short.';
			} else if ($scope.password.length > 20) {
				$scope.passwordValidationStatus = 'error';
				$scope.passwordValidationComment = 'Too long.';
			} else if (/\s/g.test($scope.password)){
				$scope.passwordValidationStatus = 'error';
				$scope.passwordValidationComment = 'Has white space.';
			} else {
				$scope.passwordValidationStatus = 'success';
				$scope.passwordValidationComment = '';
			}
		};

		$scope.signUp = function () {	
			if ($scope.userIdValidationStatus != 'success' || $scope.passwordValidationStatus != 'success')	return;

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
							$location.path('/main/chats');
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