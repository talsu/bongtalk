

bongtalkControllers.controller('StartPublicChatController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'apiClient', 'validator',
function($scope, $location, $routeParams, $http, ngDialog, apiClient, validator) {
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

bongtalkControllers.controller('StartPersonalChatController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'validator',
function($scope, $location, $routeParams, $http, ngDialog, bongtalk, validator) {
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	$scope.session = {};

	$scope.createChatNameChanged = function () {
		var result = validator.validateSessionName($scope.session.name);
		$scope.createChatNameValidationStatus = result.status;
		$scope.createChatNameValidationComment = result.comment;
	};

	$scope.createChat = function () {
		bongtalk.addSession($scope.session.name, 'public', null, function (res) {
			if (res.err) {
				$scope.$apply(function(){
					$scope.createChatNameValidationStatus = 'error';
					$scope.createChatNameValidationComment = JSON.stringify(res.err);
				});
				return;
			}

			var sessionId = res.result._id;
			$location.path('/main/' + $scope.routeLeft + '/session/' + sessionId);
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

	function init(){

	}
}]);

bongtalkControllers.controller('StartGroupChatController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'validator',
function($scope, $location, $routeParams, $http, ngDialog, bongtalk, validator) {
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	$scope.session = {};

	$scope.createChatNameChanged = function () {
		var result = validator.validateSessionName($scope.session.name);
		$scope.createChatNameValidationStatus = result.status;
		$scope.createChatNameValidationComment = result.comment;
	};

	$scope.createChat = function () {
		bongtalk.addSession($scope.session.name, 'public', null, function (res) {
			if (res.err) {
				$scope.$apply(function(){
					$scope.createChatNameValidationStatus = 'error';
					$scope.createChatNameValidationComment = JSON.stringify(res.err);
				});
				return;
			}

			var sessionId = res.result._id;
			$location.path('/main/' + $scope.routeLeft + '/session/' + sessionId);
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

	function init(){

	}
}]);
