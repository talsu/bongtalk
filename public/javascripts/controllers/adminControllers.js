
bongtalkControllers.controller('UserManagementController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'apiClient', 'validator',
function($scope, $location, $routeParams, $http, ngDialog, apiClient, validator) {
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	$scope.users = [];

	$scope.vm.ready(function(){
		init();
	});

	function init(){
		apiClient.admin_getAllUser(function (err, result){
			if (err) { alert(JSON.stringify(err)); return; }
			$scope.users = result;
		});
	}

	$scope.remove = function (userId) {
		apiClient.admin_removeUser(userId, function (err, result){
			if (err) { alert(JSON.stringify(err)); return; }
			var index = _.findIndex($scope.users, function (user) { return user.id == userId; });
			if (index > -1){
				$scope.users.splice(index, 1);
			}
		});
	};
}]);



bongtalkControllers.controller('SessionManagementController',  ['$scope', '$location', '$routeParams', '$http', 'ngDialog', 'apiClient', 'validator',
function($scope, $location, $routeParams, $http, ngDialog, apiClient, validator) {
	$scope.routeLeft = $routeParams.left || 'chats';
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	$scope.sessions = [];

	$scope.vm.ready(function () {
		init();
	});

	function init(){
		apiClient.admin_getAllSession(function (err, result){
			if (err) { alert(JSON.stringify(err)); return; }
			$scope.sessions = result;
		});
	}

	$scope.remove = function (sessionId) {
		apiClient.admin_getSession(sessionId, function (err, result){
			if (err) { alert(JSON.stringify(err)); return; }
			var users = null;
			if (result) {
				users = result.users;
			}
			apiClient.admin_removeSession(sessionId, function(err, result){
				if (err) { alert(JSON.stringify(err)); return; }
				if (users && _.isArray(users)){
					_.each(users, function(userId){
						$scope.vm.qufox.send('private:'+userId, {name:'leaveSession', object:sessionId}, function(){});
					});
				}
				var index = _.findIndex($scope.sessions, function (s) { return s._id == sessionId; });
				if (index > -1){
					$scope.sessions.splice(index, 1);
				}
			});
		});
	};
}]);
