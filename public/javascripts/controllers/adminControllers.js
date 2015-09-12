
bongtalkControllers.controller('UserManagementController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'validator',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, validator) {
		$scope.routeLeft = $routeParams.left || 'chats';
		$scope.routeRight = $routeParams.right;
		$scope.routeParam = $routeParams.param;

		$scope.users = [];
		// $scope.session = {};
		// $scope.publicSessions = [];

		// $scope.createChatNameChanged = function () {
		// 	var result = validator.validateSessionName($scope.session.name);
		// 	$scope.createChatNameValidationStatus = result.status;
		// 	$scope.createChatNameValidationComment = result.comment;
		// };

		// $scope.createChat = function () {
		// 	bongtalk.addSession($scope.session.name, 'public', null, function (res) {	
		// 		if (res.err) {
		// 			$scope.$apply(function(){ 
		// 				$scope.createChatNameValidationStatus = 'error';
		// 				$scope.createChatNameValidationComment = JSON.stringify(res.err);
		// 			});						
		// 			return;
		// 		}

		// 		var sessionId = res.result._id;
		// 		$location.path('/main/' + $scope.routeLeft + '/session/' + sessionId);
		// 	});
		// }

		if (bongtalk.user) {
			init();
		}
		else {
			bongtalk.signInReady(function (user) {
				$scope.$apply(function () { init(); });
			});			
		}

		function init(){
			bongtalk.getAllUser(function (res){
				if (res.err) return;
				$scope.$apply(function () {
					$scope.users = res.result;	
				});
			});
		}

		$scope.remove = function (userId) {
			bongtalk.removeUser(userId, function (res){
				if (res.err) { alert(JSON.stringify(res.err)); return;}
				$scope.$apply(function() {
					var index = _.findIndex($scope.users, function (user) { return user.id == userId; });
					if (index > -1){
						$scope.users.splice(index, 1);
					}					
				});
			});
		};
	}]);



bongtalkControllers.controller('SessionManagementController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'bongtalk', 'validator',
	function($scope, $location, $routeParams, $http, ngDialog, bongtalk, validator) {
		$scope.routeLeft = $routeParams.left || 'chats';
		$scope.routeRight = $routeParams.right;
		$scope.routeParam = $routeParams.param;

		$scope.sessions = [];
		// $scope.session = {};
		// $scope.publicSessions = [];

		// $scope.createChatNameChanged = function () {
		// 	var result = validator.validateSessionName($scope.session.name);
		// 	$scope.createChatNameValidationStatus = result.status;
		// 	$scope.createChatNameValidationComment = result.comment;
		// };

		// $scope.createChat = function () {
		// 	bongtalk.addSession($scope.session.name, 'public', null, function (res) {	
		// 		if (res.err) {
		// 			$scope.$apply(function(){ 
		// 				$scope.createChatNameValidationStatus = 'error';
		// 				$scope.createChatNameValidationComment = JSON.stringify(res.err);
		// 			});						
		// 			return;
		// 		}

		// 		var sessionId = res.result._id;
		// 		$location.path('/main/' + $scope.routeLeft + '/session/' + sessionId);
		// 	});
		// }

		if (bongtalk.user) {
			init();
		}
		else {
			bongtalk.signInReady(function (user) {
				$scope.$apply(function () { init(); });
			});			
		}

		function init(){
			bongtalk.getAllSession(function (res){
				if (res.err) return;
				$scope.$apply(function () {
					$scope.sessions = res.result;	
				});
			});
		}

		$scope.remove = function (sessionId) {
			bongtalk.removeSession(sessionId, function (res){
				if (res.err) { alert(JSON.stringify(res.err)); return;}
				$scope.$apply(function() {
					var index = _.findIndex($scope.sessions, function (session) { return session._id == sessionId; });
					if (index > -1){
						$scope.sessions.splice(index, 1);
					}					
				});
			});
		};
	}]);