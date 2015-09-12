bongtalkControllers.controller('SettingController', ['$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalk', 'bongtalkAutoRefreshToken', 'emitter',
	function($scope, $routeParams, $cookies, $location, ngDialog, bongtalk, bongtalkAutoRefreshToken, emitter) {		
		$scope.routeLeft = $routeParams.left;
		$scope.routeRight = $routeParams.right;
		$scope.routeParam = $routeParams.param;
		$scope.user = {};

		if (bongtalk.user) {
			init();
		}
		else {
			bongtalk.signInReady(function (user) {
				$scope.$apply(function () { init(); });
			});			
		}

		function init() {
			$scope.user = bongtalk.user;
		}

		bongtalk.signInReady(function (user) {
			if (user){
				// $scope.$apply(function() { $scope.user = user; });
				
			}
		});
		

		// Sync username
		bongtalk.on('setMyInfo', onSetMyInfo);
		$scope.$on('$destroy', function () { bongtalk.off('setMyInfo', onSetMyInfo); });
		function onSetMyInfo(data){
			$scope.$apply(function() { $scope.user = bongtalk.user; });
		}
	}]);


bongtalkControllers.controller('SetUsernameController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'validator',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, validator) {
		$scope.routeLeft = $routeParams.left || 'chats';
		$scope.routeRight = $routeParams.right;
		$scope.routeParam = $routeParams.param;
		$scope.user = {};
		$scope.currentUserName = '';
		$scope.userNameChanged = function () {
			var result = validator.validateUserName($scope.user.name);
			$scope.userNameValidationStatus = result.status;
			$scope.userNameValidationComment = result.comment;
		};

		$scope.setUsername = function () {
			bongtalk.setMyInfo({name:$scope.user.name}, function (res){
				if (res.err) {alert(err); return;}
				if (res.result.ok) {					
					$scope.$apply(function(){ 
						$scope.userNameValidationStatus = 'success';
						$scope.userNameValidationComment = 'Set username success.';
					});
				}
			});
		}

		if (bongtalk.user) {
			init();
		}
		else {
			bongtalk.signInReady(function (user) {
				$scope.$apply(function () { init(); });
			});			
		}

		function init() {
			$scope.currentUserName = bongtalk.user.name;
		}

		// Sync username
		bongtalk.on('setMyInfo', onSetMyInfo);
		$scope.$on('$destroy', function () { bongtalk.off('setMyInfo', onSetMyInfo); });
		function onSetMyInfo(data){
			$scope.$apply(function() { 
				$scope.currentUserName = bongtalk.user.name; 

				if ($scope.routeParam == 'first') {
					$location.path('/main/' + $scope.routeLeft + '/start-public-chat');
				}
			});
		}
	}]);


bongtalkControllers.controller('SetPasswordController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'validator',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, validator) {
		$scope.currentPasswordValidationStatus = '';
		$scope.newPasswordValidationStatus = '';
		$scope.confirmPasswordValidationStatus = '';
		$scope.validationComment = '';
		$scope.user = {
			currentPassword:'',
			newPassword:'',
			confirmPassword:''
		};

		$scope.currentPasswordChanged = function (){
			$scope.newPasswordChanged();
		};

		$scope.newPasswordChanged = function (){			
			var result = validator.validatePassword($scope.user.newPassword);
			$scope.newPasswordValidationStatus = result.status;
			$scope.validationComment = result.comment;

			$scope.confirmPasswordChanged();
		};

		$scope.confirmPasswordChanged = function (){
			if (!$scope.user.confirmPassword || $scope.newPasswordValidationStatus != 'success') {
				$scope.confirmPasswordValidationStatus = '';
			}
			else if ($scope.user.newPassword == $scope.user.confirmPassword){
				$scope.confirmPasswordValidationStatus = 'success';
			}
			else {
				$scope.confirmPasswordValidationStatus = 'error';				
			}

		};

		$scope.isDisableChangePassword = function () {
			return !$scope.user.currentPassword || 
			$scope.newPasswordValidationStatus != 'success' || 
			$scope.confirmPasswordValidationStatus != 'success';
		}

		$scope.setPassword = function () {
			if (!$scope.isDisableChangePassword()){
				bongtalk.changePassword($scope.user.currentPassword, $scope.user.newPassword, function (res){
					$scope.$apply(function(){
						if (res.err) {
							$scope.user.newPassword = '';
							$scope.user.confirmPassword = '';
							$scope.currentPasswordValidationStatus = 'error';
							$scope.newPasswordValidationStatus = '';
							$scope.confirmPasswordValidationStatus = '';
							$scope.validationComment = res.err;
						}
						else if (res.result.ok) {
							$scope.user = {
								currentPassword:'',
								newPassword:'',
								confirmPassword:''
							};		
							$scope.currentPasswordValidationStatus = 'success';
							$scope.newPasswordValidationStatus = '';
							$scope.confirmPasswordValidationStatus = '';
							$scope.validationComment = 'Change password success.';
						}
					});
				});
			}
		};
	}]);