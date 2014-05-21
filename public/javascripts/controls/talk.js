'use strict';

define(['controllers', 'underscore', 'modules/socketConnector', 'bootstrap'], function (controllers, _, connector){
	controllers.controller('talkCtrl', [ '$scope', '$routeParams', '$location', function($scope, $routeParams, $location){
		$scope.serverStatus = connector.status;
		connector.addListener('statusChanged', serverStatusChanged);
		function serverStatusChanged (status){
			$scope.$apply(function(){
				$scope.serverStatus = status;
			});
		};

		connector.runWithConnection(function(){
			var connectionId = null;
			$scope.channelId = $routeParams.channelId;
			$scope.me = new TalkUser({
				id : $routeParams.userid, 
				name : $routeParams.username, 
				avatar : 'http://placehold.it/50/FA6F57/fff&text=ME'
			});
			$scope.others = [];
			$scope.onlineUsers = [];
			var talks = [];
			var lastTalkGroup = null;
			$scope.talkGroups = [];
			connector.request('getUserFromChannel', {
				channelId:$scope.channelId, 
				userId:$scope.me.id},
				function(res){
					if (res.result){
						$scope.me.id = res.result.id;
						$scope.me.name = res.result.name;
						joinChannel();
					}
					else{
						connector.request('addUserToChannel', {
							channelId:$scope.channelId, 
							userName:$scope.me.name,
							userId:$scope.me.id}, 
							function(res){
								if (res.err){
									alert(JSON.stringify(res.err));
									return;
								}

								if (res.result && res.result.id){
									refreshWithUserId(res.result.id);
								}
							}
						);
					}				
				}
			);

			$scope.$on('$destroy', function cleanup() {
				releaseConnectorEvents();

				if (connectionId){
					connector.request('leaveChannel', {connectionId:connectionId});
				}
			});

			
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



			$scope.inputKeypress = function($event){
				if ($event.keyCode === 13) // Enter key pess
				{
					$scope.sendMessage();
				}
			};

			$scope.sendMessage = function(){
				if (!$scope.inputTalkMessage){
					return;
				}
				var data = {
					id:'temp' + new Date,
					userId:$scope.me.id, 
					channelId:$scope.channelId, 
					message:$scope.inputTalkMessage, 
					time:new Date()
				};

				var talk = addTalk(data);
				$scope.inputTalkMessage = '';
				connector.request('addNewTalk', data, function(res){
					if (res.err){
						alert(JSON.stringify(res.err));
						return;
					}
					if (talk){
						$scope.$apply(function(){
							talk.id = res.result.id;
							talk.time = res.result.time;
						});
					}
					
				});
			};


			// var isCopiedShareUrlTimer = null;
			// $scope.copyShareUrlComplete = function(){
			// 	$scope.isCopiedShareUrl = true;

			// 	if (isCopiedShareUrlTimer){
			// 		clearTimeout(isCopiedShareUrlTimer);	
			// 	}				

			// 	isCopiedShareUrlTimer = setTimeout(function(){
			// 		$scope.$apply(function(){
			// 			$scope.isCopiedShareUrl = false;
			// 		});
			// 	}, 2000);
			// };
			var isSetNewNameTimer = null;			
			$scope.setNewName = function(){
				if ($scope.newName && ($scope.newName !== $scope.me.name)){
					$scope.changingUsername = true;					
					connector.request('updateUser', 
						{
							channelId:$scope.channelId, 
							userId:$scope.me.id, 
							propertyName:'name', 
							data:$scope.newName
						}, function (res){
							if (!res.err){
								onUpdateUser(res.result);
							}
							$scope.$apply(function(){
								if (!res.err){
									$scope.isSettedNewName = true;
									if (isSetNewNameTimer) {clearTimeout(isSetNewNameTimer);}
									isSetNewNameTimer = setTimeout(function(){
										$scope.$apply(function(){$scope.isSettedNewName = false;})
									}, 2000);
								}

								$scope.changingUsername = false;
								$scope.newName = '';
							});
							
						});					
				}
			};

			$scope.openNewPopupWindow = function(){
				var url = encodeURI(window.location.protocol + '//' + window.location.host + '/p#/ch/' + $scope.channelId + '?userid=' + $scope.me.id);
				window.open(url, "_blank", "directories=no, location=no, menubar=no, status=no, titlebar=no, toolbar=no, scrollbars=no, resizable=yes, width=300, height=485");
			};

			function onNewTalk(talk){
				$scope.$apply(function(){
					addTalk(talk);					
				});
			}

			function onAddUser(user){
				$scope.$apply(function(){
					$scope.addUser(new TalkUser(user));
				});
			}

			function onRemoveUser(userId){
				$scope.$apply(function(){
					$scope.removeUser(userId);
				});	
			}

			function onUpdateUser(data){
				if (data.userId && data.propertyName){
					var user = $scope.getUser(data.userId);
					if (user){
						$scope.$apply(function(){
							user[data.propertyName] = data.data;

							if (data.propertyName === 'connections'){
								updateOnlineUser(user);
							}
						});
					}	
				}
			}

			function onReconnected(){
				joinChannel(true);
			}

			function addTalk(data){
				if (!(data.id) || _.any(talks, function (talk){return talk.id === data.id;})){
					return null;
				}

				var newTalk = new Talk(data);
				talks.push(newTalk);

				if (lastTalkGroup && lastTalkGroup.canAdd(newTalk)){
					lastTalkGroup.addTalk(newTalk);
				}
				else{
					var talkGroup = new TalkGroup(newTalk);
					$scope.talkGroups.push(talkGroup);
					lastTalkGroup = talkGroup;
				}

				return newTalk;
			}

			function joinChannel(isReconnected){
				connector.request('joinChannel', {channelId:$scope.channelId, userId:$scope.me.id}, function(res){
					if (res.err){
						alert(JSON.stringify(res.err));
						return;
					}

					setConnectorEvents();					
					connectionId = res.result.connectionId;
					var users = res.result.users;
					var talks = res.result.talks;
					
					$scope.$apply(function(){
						if (_.isArray(users)){
							_.each(users, function (user){ $scope.addUser(new TalkUser(user)); });
						}

						if (_.isArray(talks)){
							_.each(talks, function (talk){ addTalk(talk); });
						}
					});
				});
			}

			function setConnectorEvents(){
				connector.addListener('reconnected', onReconnected);			
				connector.addEventListener('onNewTalk', $scope.channelId, onNewTalk);
				connector.addEventListener('onAddUser', $scope.channelId, onAddUser);
				connector.addEventListener('onRemoveUser', $scope.channelId, onRemoveUser);
				connector.addEventListener('onUpdateUser', $scope.channelId, onUpdateUser);	
			}

			function releaseConnectorEvents(){				
				connector.removeListener('reconnected', onReconnected);
				connector.removeEventListener('onNewTalk', $scope.channelId, onNewTalk);
				connector.removeEventListener('onAddUser', $scope.channelId, onAddUser);
				connector.removeEventListener('onRemoveUser', $scope.channelId, onRemoveUser);
				connector.removeEventListener('onUpdateUser', $scope.channelId, onUpdateUser);	

				connector.removeListener('statusChanged', serverStatusChanged);
			}

			function refreshWithUserId(userId){
				window.location = encodeURI(window.location.pathname + '#/ch/' + $scope.channelId + '?userid=' + userId);
			}

			$scope.getShareUrl = function(){
				return encodeURI(window.location.protocol + '//' + window.location.host + window.location.pathname + '#/ch/' + $scope.channelId);
			};

			var isCopiedShareUrlTimer = null;
			$scope.copyShareUrlComplete = function(){
				$scope.isCopiedShareUrl = true;

				if (isCopiedShareUrlTimer){
					clearTimeout(isCopiedShareUrlTimer);	
				}				

				isCopiedShareUrlTimer = setTimeout(function(){
					$scope.$apply(function(){
						$scope.isCopiedShareUrl = false;
					});
				}, 2000);
			};

			$scope.addUser = function (user) {
				if (!user || !(user instanceof TalkUser))
				{
					return;
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
				}

				updateOnlineUser(user);
			};

			$scope.removeUser = function (userId) {
				var user = $scope.getUser(userId);

				if (user)
				{
					$scope.others.splice($scope.others.indexOf(user), 1);

					var onlineUser = _.find($scope.onlineUsers, function(item){return item.id === user.id;});
					if (onlineUser){
						$scope.onlineUsers.splice($scope.onlineUsers.indexOf(onlineUser), 1);
					}
				}

				return user;
			};

			function updateOnlineUser(user){
				if (!user || !(user instanceof TalkUser) || user.id === $scope.me.id)
				{
					return;
				}

				var existUser = _.find($scope.onlineUsers, function(item){return item.id === user.id;});

				if (existUser){
					if (!user.isAlive()){
						//지우기
						$scope.onlineUsers.splice($scope.onlineUsers.indexOf(existUser), 1);
					}
				}
				else{
					if (user.isAlive()){
						//추가
						$scope.onlineUsers.push(user);
					}
				}
			}

			if(!$scope.$$phase) {
				$scope.$apply();
			}
		});
	}]);

	var Talk = (function(){
		function Talk(data){
			this.id = data.id;
			this.message = data.message;
			this.time = data.time ? new Date(data.time) : null;
			this.userId = data.userId;
		}

        Talk.prototype.getTimeString = function() {
            if (this.time instanceof Date){
                var dateTime = this.time;
                return (dateTime.getHours() < 10 ? '0' + dateTime.getHours() : dateTime.getHours())
                    + ':' +
                    (dateTime.getMinutes() < 10 ? '0' + dateTime.getMinutes() : dateTime.getMinutes());
            }

            return '';
        };

		return Talk;
	})();

	var TalkGroup = (function(){
		function TalkGroup(talk){
			this.userId = talk.userId;
			this.messages = [];
			this.addTalk(talk);
		}

		TalkGroup.prototype.addTalk = function(talk) {
			this.messages.push({id:talk.id, text:talk.message});
			this.time = talk.time;
		};

		TalkGroup.prototype.getTimeString = function() {
            if (this.time instanceof Date){
                var dateTime = this.time;
                return (dateTime.getHours() < 10 ? '0' + dateTime.getHours() : dateTime.getHours())
                    + ':' +
                    (dateTime.getMinutes() < 10 ? '0' + dateTime.getMinutes() : dateTime.getMinutes());
            }

            return '';
        };

        TalkGroup.prototype.canAdd = function(talk){
        	return talk 
        	&& talk.time instanceof Date
        	&& talk.userId === this.userId 
        	&& (((talk.time - this.time) / 60000) < 1);
        };

		return TalkGroup;
	})();

	var TalkUser = (function () {
		function TalkUser(data) {
			this.id = data.id;
			this.name = data.name;
			this.connections = data.connections || 0;
			this.avatar = data.avatar || 'http://placehold.it/50/55C1E7/fff&text=U';
		}

		TalkUser.prototype.getSimpleUser = function() {
			return {id:this.id, name:this.name};
		};

		TalkUser.prototype.update = function(user) {
			this.name = user.name;
			this.connections = user.connections;
		};

		TalkUser.prototype.isAlive = function(){
			return _.isNumber(this.connections) && this.connections > 0;
			// return _.isArray(this.connections) && this.connections.length > 0;
		};

		return TalkUser;
	})();
});
