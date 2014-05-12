'use strict';

define(['controllers', 'underscore', 'modules/socketConnector'], function (controllers, _, connector){

	// var controllers = angular.module('appControllers', []);

	controllers.controller('talkCtrl', [ '$scope', '$routeParams', function($scope, $routeParams){
		$scope.channelId = $routeParams.channelId;
		$scope.me = new TalkUser('123', 'Talsu');
		$scope.others = [];
		$scope.talks = [];
		$scope.lastTalk = null;

		$scope.getUser = function (userId) {
			if ($scope.me.id === userId){
				return $scope.me;
			}

			var selectedUsers = $scope.others.filter(function(item){ return item.id === userId;});
			if (selectedUsers && selectedUsers.length > 0)
			{
					return selectedUsers[0];
			}

			return null;
		};

		$scope.addUser = function (user) {
				if (!user || !(user instanceof TalkUser))
				{
						return null;
				}

				var selectedUsers = $scope.others.filter(function(item){return item.id === user.id;});

				if (selectedUsers.length > 0){
						// 존재한다면;
						var selectedUser = selectedUsers[0];
						selectedUser.update(user);
				}
				else{
						// 같은 ID를 가진 놈이 없다면 추가하라.
						$scope.others.push(user);
						return user;
				}

				return null;
		};

		$scope.removeUser = function (userId) {
				var user = $scope.getUser(userId);

				if (user)
				{
						$scope.others.splice($scope.others.indexOf(user), 1);
				}

				return user;
		};
		// $scope.addUser($scope.me);
		$scope.addUser(new TalkUser('321', 'bongsik'));

		addTalk({sender:'123', message:'h2ello', time:new Date()});
		addTalk({sender:'321', message:'hel3lo', time:new Date()});
		addTalk({sender:'123', message:'hel4lo', time:new Date()});
		addTalk({sender:'321', message:'he5lo', time:new Date()});


		function addTalk(data){
			var newTalk = new Talk(data);
			$scope.talks.push(newTalk);
			$scope.lastTalk = newTalk;
		}


	}]);

	var Talk = (function(){
		function Talk(data){
			this.id = data.id;
			this.message = data.message;
			this.time = data.time;
			this.sender = data.sender;
		}

		return Talk;
	})();

	var TalkUser = (function () {
			function TalkUser(id, name, connections) {
					this.id = id;
					this.name = name;
					this.connections = connections;
			}

			TalkUser.prototype.getSimpleUser = function() {
					return {id:this.id, name:this.name};
			};

			TalkUser.prototype.update = function(user) {
					this.name = user.name;
					this.connections = user.connections;
			};

			TalkUser.prototype.isAlive = function(){
					return Array.isArray(this.connections) && this.connections.length > 0;
			};

			return TalkUser;
	})();
});
