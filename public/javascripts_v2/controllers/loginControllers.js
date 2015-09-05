'use strict';


bongtalkControllers.controller('LoginController',  ['$scope', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $routeParams, $http, ngDialog, bongtalk, emitter) {

	}]);

bongtalkControllers.controller('LoginDialogController',  ['$scope', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $routeParams, $http, ngDialog, bongtalk, emitter) {
		//$scope.closeThisDialog();
		$scope.noAccount = function () {			
			
		};
		$scope.openSignIn = function () {
			$scope.closeThisDialog();
			ngDialog.open({
				template:'/partials_v2/signInDialog.html',
				className: 'ngdialog-theme-default login_dialog',
				controller: 'SignInDialogController',
				closeByDocument: false,
				closeByEscape: false,
				showClose: false
			});	
			
		};

		$scope.openSignUp = function () {			
			$scope.closeThisDialog();
			ngDialog.open({
				template:'/partials_v2/signUpDialog.html',
				className: 'ngdialog-theme-default login_dialog',
				controller: 'SignUpDialogController',
				closeByDocument: false,
				closeByEscape: false,
				showClose: false
			});	
		};
	}]);

bongtalkControllers.controller('SignInDialogController',  ['$scope', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $routeParams, $http, ngDialog, bongtalk, emitter) {
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
				if (res.err) {
					$scope.$apply(function () { $scope.loginResult = 'error'; });
				}
				else {
					$scope.$apply(function () { $scope.loginResult = 'success'; });
					
					$scope.closeThisDialog();
				}
			});
		};

		$scope.back = function () {
			$scope.closeThisDialog();
			ngDialog.open({
				template:'/partials_v2/loginDialog.html',
				className: 'ngdialog-theme-default login_dialog',
				controller: 'LoginDialogController',
				closeByDocument: false,
				closeByEscape: false,
				showClose: false
			});
		};
	}]);


bongtalkControllers.controller('SetUsernameInDialogController',  ['$scope', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $routeParams, $http, ngDialog, bongtalk, emitter) {
		$scope.userNameValidationStatus = '';
		$scope.userNameValidationComment = '';
		$scope.currentUserName = '';
		$scope.userNameChanged = function () {
			if (!$scope.userName) {
				$scope.userNameValidationStatus = '';
				$scope.userNameValidationComment = '';
			} else if ($scope.userName.length < 2) {
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

bongtalkControllers.controller('SignUpDialogController',  ['$scope', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $routeParams, $http, ngDialog, bongtalk, emitter) {

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

						// Every thing success.
						$scope.closeThisDialog();
						// Go setUsername.
						ngDialog.open({
							template:'/partials_v2/setUsernameDialog.html',
							className: 'ngdialog-theme-default login_dialog',
							controller: 'SetUsernameInDialogController',
							closeByDocument: false,
							closeByEscape: false,
							showClose: false
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
			$scope.closeThisDialog();
			ngDialog.open({
				template:'/partials_v2/loginDialog.html',
				className: 'ngdialog-theme-default login_dialog',
				controller: 'LoginDialogController',
				closeByDocument: false,
				closeByEscape: false,
				showClose: false
			});
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