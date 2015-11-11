bongtalkControllers.controller('SettingController', ['$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalkAutoRefreshToken', 'emitter',
function($scope, $routeParams, $cookies, $location, ngDialog, bongtalkAutoRefreshToken, emitter) {
	$scope.routeLeft = $routeParams.left;
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
}]);

bongtalkControllers.controller('SetProfileController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'validator', 'focus', 'apiClient',
function($scope, $location, $routeParams, $http, ngDialog, validator, focus, apiClient) {
	focus();
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	$scope.user = {};
	$scope.currentUserName = '';

	$scope.chageAvatarUrlRandom = function (){
		apiClient.getRandomAvatarUrl(function (err, result){
			if (!err) {
				$scope.vm.setMyInfo({avatarUrl:result},
					function (err, result) {
						if (err) {
							$scope.setUserAvatarUrlStatus = err;
						}
					}
				);
			}
			else {
				$scope.setUserAvatarUrlStatus = err;
			}
		});
	};

	$scope.userNameChanged = function () {
		var result = validator.validateUserName($scope.user.name);
		$scope.userNameValidationStatus = result.status;
		$scope.userNameValidationComment = result.comment;
	};

	$scope.setUsername = function () {
		if (validator.validateUserName($scope.user.name).status !== 'success'){
			this.userNameChanged();
			return;
		}
		$scope.vm.setMyInfo({name:$scope.user.name}, function (err, result){
			if (err) {alert(err); return;}
			$scope.userNameValidationStatus = 'success';
			$scope.userNameValidationComment = 'Set username success.';
		});
	}

	$scope.vm.ready(function() {
		$scope.currentUserName = $scope.vm.data.me.name;
	});

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
			apiClient.changePassword($scope.user.currentPassword, $scope.user.newPassword, function (err, result){
				// $scope.$apply(function(){
				if (err) {
					$scope.user.newPassword = '';
					$scope.user.confirmPassword = '';
					$scope.currentPasswordValidationStatus = 'error';
					$scope.newPasswordValidationStatus = '';
					$scope.confirmPasswordValidationStatus = '';
					$scope.validationComment = err;
				}
				else if (result.ok) {
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
				// });
			});
		}
	};
}]);


bongtalkControllers.controller('SetUsernameController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'validator', 'focus',
function($scope, $location, $routeParams, $http, ngDialog, validator, focus) {
	focus();
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
		if (validator.validateUserName($scope.user.name).status !== 'success'){
			this.userNameChanged();
			return;
		}
		$scope.vm.setMyInfo({name:$scope.user.name}, function (err, result){
			if (err) {alert(err); return;}
			$scope.userNameValidationStatus = 'success';
			$scope.userNameValidationComment = 'Set username success.';
		});
	}

	$scope.vm.ready(function() {
		$scope.currentUserName = $scope.vm.data.me.name;
	});
}]);


bongtalkControllers.controller('SetPasswordController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'apiClient', 'validator', 'focus',
function($scope, $location, $routeParams, $http, ngDialog, apiClient, validator, focus) {
	focus();
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
			apiClient.changePassword($scope.user.currentPassword, $scope.user.newPassword, function (err, result){
				// $scope.$apply(function(){
				if (err) {
					$scope.user.newPassword = '';
					$scope.user.confirmPassword = '';
					$scope.currentPasswordValidationStatus = 'error';
					$scope.newPasswordValidationStatus = '';
					$scope.confirmPasswordValidationStatus = '';
					$scope.validationComment = err;
				}
				else if (result.ok) {
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
				// });
			});
		}
	};
}]);
