

bongtalkControllers.controller('StartPublicChatController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'apiClient', 'validator', 'focus',
function($scope, $location, $routeParams, $http, ngDialog, apiClient, validator, focus) {
	focus();
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	$scope.session = {};
	$scope.publicSessions = [];

	$scope.vm.ready(function () {
		init();
	});

	$scope.createChatNameChanged = function () {
		var result = validator.validateSessionName($scope.session.name);
		$scope.createChatNameValidationStatus = result.status;
		$scope.createChatNameValidationComment = result.comment;
	};

	$scope.createChat = function () {
		if (validator.validateSessionName($scope.session.name).status !== 'success'){
			this.createChatNameChanged();
			return;
		}
		$scope.vm.createSession($scope.session.name, 'public', function (err, result) {
			var session = result;
			if (err) {
				$scope.createChatNameValidationStatus = 'error';
				$scope.createChatNameValidationComment = JSON.stringify(err);
			} else {
				$location.path('/main/' + $scope.routeLeft + '/session/' + session._id);
			}
		});
	};

	function init(){
		apiClient.getPublicSessions(function (err, result){
			if (err) return;
			$scope.publicSessions = result;
		});
	}
}]);

bongtalkControllers.controller('StartPersonalChatController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'validator',
function($scope, $location, $routeParams, $http, ngDialog, validator) {
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;

}]);

bongtalkControllers.controller('StartGroupChatController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'validator',
function($scope, $location, $routeParams, $http, ngDialog, validator) {
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;

}]);
