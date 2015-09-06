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


bongtalkControllers.controller('SetUsernameController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, emitter) {
		$scope.user = {};
		$scope.currentUserName = '';
		$scope.userNameChanged = function () {
			if (!$scope.user.name) {
				$scope.userNameValidationStatus = '';
				$scope.userNameValidationComment = '';
			} else if ($scope.user.name.length < 2) {
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = 'Username is too short.';
			} else if ($scope.user.name.length > 20) {
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = 'Username is too long.';
			} else if (/\s/g.test($scope.user.name)){
				$scope.userNameValidationStatus = 'error';
				$scope.userNameValidationComment = 'Has white space.';
			} else {
				$scope.userNameValidationStatus = 'success';
				$scope.userNameValidationComment = '';
			}
			
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


bongtalkControllers.controller('SetPasswordController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, emitter) {
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
					//$scope.closeThisDialog();
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