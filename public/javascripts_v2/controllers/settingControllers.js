bongtalkControllers.controller('SettingController', ['$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalk', 'bongtalkAutoRefreshToken', 'emitter',
	function($scope, $routeParams, $cookies, $location, ngDialog, bongtalk, bongtalkAutoRefreshToken, emitter) {		
		$scope.routeLeft = $routeParams.left;
		$scope.routeRight = $routeParams.right;
		$scope.routeParam = $routeParams.param;

		bongtalk.getMyInfo(function (res) {
			if (res && !res.err && res.result){
				$scope.$apply(function() { $scope.user = res.result; });
			}
		});
	}]);


bongtalkControllers.controller('SetUsernameController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'validator',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, validator) {
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

		// $scope.close = function () {
		// 	$scope.closeThisDialog();
		// };

		bongtalk.getMyInfo(function (res) {
			commonResponseHandle(res);

			if (res.result && res.result.name && $scope.currentUserName != res.result.name){
				$scope.$apply(function () {
					$scope.currentUserName = res.result.name;
				});
			}
		});
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