bongtalkControllers.controller('SessionListController', ['$scope', '$routeParams', '$http', 'bongtalk', 'emitter',
function($scope, $routeParams, $http, bongtalk, emitter) {
	$scope.routeLeft = $routeParams.left;
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;

}]);


bongtalkControllers.controller('SessionInfoController', ['$scope', '$routeParams', '$location', 'bongtalk', 'emitter',
function($scope, $routeParams, $location, bongtalk, emitter) {
	$scope.routeLeft = $routeParams.left;
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	var currentSessionId = $scope.routeParam;

	$scope.vm.ready(function () {
		init();
	});

	function init() {
		if (currentSessionId) {
			if (!angular.isArray($scope.vm.data.sessionList)) { $location.path('/main/' + $scope.routeLeft); return; }
			var currentSession = _.find($scope.vm.data.sessionList, function (session) { return session._id == currentSessionId; });
			if (currentSession) {
				$scope.currentSession = currentSession;
				$scope.vm.loadUsers(currentSession);
			}
			else {
				$scope.vm.joinSession(currentSessionId, function (err, result){
					if (err) {
						alert(err);
						$location.path('/main/' + $scope.routeLeft); return;
					}
					else {
						$scope.currentSession = result;
						$scope.vm.loadUsers(currentSession);
					}
				});
			}
		}
	}
}]);


bongtalkControllers.controller('SessionController', ['$scope', '$routeParams', '$location', 'bongtalk', 'emitter',
function($scope, $routeParams, $location, bongtalk, emitter) {
	$scope.routeLeft = $routeParams.left;
	$scope.routeRight = $routeParams.right;
	$scope.routeParam = $routeParams.param;
	var currentSessionId = $scope.routeParam;
	$scope.input = {};

	$scope.vm.ready(function () {
		init();
	});

	function init() {
		if (currentSessionId) {
			if (!angular.isArray($scope.vm.data.sessionList)) { $location.path('/main/chats'); return; }
			var currentSession = _.find($scope.vm.data.sessionList, function (session) { return session._id == currentSessionId; });
			if (currentSession) {
				$scope.currentSession = currentSession;
				$scope.vm.loadTelegrams(currentSession);
			}
			else {
				$scope.vm.joinSession(currentSessionId, function (err, result){
					if (err) {
						alert(err);
						$location.path('/main/chats'); return;
					}
					else {
						$scope.currentSession = result;
						$scope.vm.loadTelegrams(result);
					}
				});
			}
		}
	}

	function onLeaveSession(sessionId){
		if ($scope.session && $scope.session._id == sessionId) {
			$location.path('/main/'+ $scope.routeLeft);
		}
	}

	function sendMessage (){
		if (!$scope.input.text){
			return;
		}

		var telegram = {
			_id:randomString(8),
			sessionId:$scope.currentSession._id,
			userId:$scope.vm.data.user.id,
			userName:$scope.vm.data.user.name,
			type:'talk',
			subType:'text',
			data:$scope.input.text,
			time:(new Date()).getTime()
		};

		$scope.input.text = '';
		$scope.vm.sendTelegram($scope.currentSession, telegram);
	};

	$scope.inputKeypress = function($event){
		if ($event.keyCode === 13) // Enter key pess
		{
			sendMessage();
		}
	}

	function randomString(length) {
		var letters = 'abcdefghijklmnopqrstuvwxyz';
		var numbers = '1234567890';
		var charset = letters + letters.toUpperCase() + numbers;

		function randomElement(array) {
			return array[Math.floor(Math.random()*array.length)];
		}

		var result = '';
		for(var i=0; i<length; i++)
		result += randomElement(charset);
		return result;
	}
}]);
