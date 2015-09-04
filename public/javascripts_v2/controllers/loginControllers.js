'use strict';

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
		$scope.userIdChanged = function () {
			console.log($scope.userId);
		};

		$scope.passwordChanged = function () {
			console.log($scope.password);
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

						if (!res.result) {
							alert('Empty token.');
							return;							
						}

						// Every thing success.
						bongtalk.setAuthToken(res.result);
						$scope.closeThisDialog();
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