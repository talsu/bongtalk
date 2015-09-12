bongtalkControllers.controller('SessionListController', ['$scope', '$routeParams', '$http', 'bongtalk', 'emitter',
	function($scope, $routeParams, $http, bongtalk, emitter) {
		$scope.routeLeft = $routeParams.left;
		$scope.routeRight = $routeParams.right;
		$scope.routeParam = $routeParams.param;
		$scope.sessions = [];

		// bongtalk.getAllChannel(function (sessions){
		// 	$scope.$apply(function(){
		// 		_.each(sessions.result, function (sessionName) {$scope.sessions.push({name:sessionName, isSelected:''});});
		// 	});
		// });

		bongtalk.signInReady(function(){
			bongtalk.getUserSessions(function (res) {
				if (res.err) return;
				$scope.$apply(function(){
					_.each(res.result, function (session) {$scope.sessions.push(session);});
				});
			});
		});
		

		// Sync username
		bongtalk.on('joinSession', onJoinSession);
		bongtalk.on('leaveSession', onLeaveSession);
		$scope.$on('$destroy', function () { 
			bongtalk.off('joinSession', onJoinSession); 
			bongtalk.off('leaveSession', onLeaveSession);
		});
		function onJoinSession(sessionId){
			bongtalk.getSession(sessionId, function (res){
				if (res.err) return;
				$scope.$apply(function(){
					var index = _.findIndex($scope.sessions, function (session) { return session._id == sessionId; });
					if (index == -1){
						$scope.sessions.push(res.result);
					}
				});
			});
			
		}
		function onLeaveSession(sessionId){
			$scope.$apply(function(){
				var index = _.findIndex($scope.sessions, function (session) { return session._id == sessionId; });
				if (index > -1){
					$scope.sessions.splice(index, 1);
				}
			});
		}
	}]);


bongtalkControllers.controller('SessionController', ['$scope', '$routeParams', '$location', 'bongtalk', 'emitter',
	function($scope, $routeParams, $location, bongtalk, emitter) {	
		$scope.routeLeft = $routeParams.left;
		$scope.routeRight = $routeParams.right;
		$scope.routeParam = $routeParams.param;
		$scope.telegrams = [];
		$scope.input = {};

		if (bongtalk.user) {
			init();
		}
		else {
			bongtalk.signInReady(function (user) {
				$scope.$apply(function () { init(); });
			});			
		}

		// setReceiver
		bongtalk.onTelegram($scope.routeParam, onTelegram);
		bongtalk.on('leaveSession', onLeaveSession);
		$scope.$on('$destroy', function () { 
			bongtalk.offTelegram($scope.routeParam, onTelegram); 
			bongtalk.on('leaveSession', onLeaveSession);
		});

		function init() {
			$scope.user = bongtalk.user;
			bongtalk.getSession($scope.routeParam, function (res){
				if (res.err || !res.result){
					$location.path('/main/'+ $scope.routeLeft);
					return;
				}
				$scope.$apply(function () { $scope.session = res.result; });
				bongtalk.getTelegrams($scope.routeParam, 0, 0, function (res){
					if (!res.err && res.result && res.result.length > 0){
						$scope.$apply(function () { 
							_.each(res.result, function (telegram){
								addTelegram(telegram);
							});
						});
					}
				});
			});
		}

		function onLeaveSession(sessionId){
			if ($scope.session && $scope.session._id == sessionId) {
				$location.path('/main/'+ $scope.routeLeft);
			}
		}

		function onTelegram(telegram){
			$scope.$apply(function () { addTelegram(telegram); });
		}
		function addTelegram(telegram) {
			$scope.telegrams.push(telegram);
		}

		function sendMessage (){
			if (!$scope.input.text){
				return;
			}
			
			var telegram = {
				_id:randomString(8),
				sessionId:$scope.session._id,
				userId:$scope.user.id, 
				userName:$scope.user.name,
				type:'talk',
				subType:'text',
				data:$scope.input.text, 
				time:(new Date()).getTime()
			};

			addTelegram(telegram);
			$scope.input.text = '';
			bongtalk.addTelegram(telegram.sessionId, telegram.type, telegram.subType, telegram.data, function (res){
				if (res.err){
					alert(JSON.stringify(res.err));
					return;
				}

				$scope.$apply(function() {
					
					telegram._id = res.result._id;
					telegram.time = res.result.time;
				});
			});
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


// bongtalkControllers.controller('OLD_SessionController', ['$scope', '$routeParams', '$http', 'bongtalk', 'emitter',
// 	function($scope, $routeParams, $http, bongtalk, emitter) {		
// 		$scope.routeLeft = $routeParams.left;
// 		$scope.routeRight = $routeParams.right;
// 		$scope.routeParam = $routeParams.param;
// 		$scope.me = new TalkUser({
// 			id : 'asdfasf', 
// 			name : 'TestMan', 
// 			avatar : 'http://placehold.it/50/FA6F57/fff&text=ME'
// 		});

// 		var connectionId = null;
// 		$scope.channelId = null;		
// 		$scope.others = [];
// 		$scope.onlineUsers = [];
// 		var talks = [];
// 		var lastTalkGroup = null;
// 		$scope.talkGroups = [];
// 		var channel = null;
// 		$scope.inputTalk = {};

// 		openSession($routeParams.param);

// 		function init() {
// 			if (channel) {
// 				releaseConnectorEvents();
// 				if (connectionId){
// 					channel.leave({connectionId:connectionId});
// 				}
// 			}

// 			connectionId = null;
// 			$scope.channelId = null;		
// 			$scope.others = [];
// 			$scope.onlineUsers = [];
// 			talks = [];
// 			lastTalkGroup = null;
// 			$scope.talkGroups = [];
// 			channel = null;
// 			$scope.inputTalk = {};
// 		}

// 		function openSession(sessionName){
// 			init();
			
// 			$scope.channelId = sessionName;
			

// 			channel = bongtalk.joinChannel($scope.channelId, $scope.me.id, $scope.me.name);
// 			channel.getUser($scope.me.id,
// 				function(res){
// 					if (res.result){
// 						$scope.me.id = res.result.id;
// 						$scope.me.name = res.result.name;
// 						joinChannel();
// 					}
// 					else{
// 						channel.addUser(
// 							$scope.me.id, $scope.me.name,
// 							function(res){
// 								if (res.err){
// 									alert(JSON.stringify(res.err));
// 									return;
// 								}

// 								if (res.result && res.result.id){
// 									refreshWithUserId(res.result.id);
// 								}
// 							}
// 						);
// 					}
// 				}
// 			);
// 		}

// 		// $scope.serverStatus = bongtalk.qufox.status;

// 		// bongtalk.qufox.onStatusChanged(serverStatusChanged);
// 		// function serverStatusChanged (status){
// 		// 	$scope.$apply(function(){
// 		// 		$scope.serverStatus = status;
// 		// 	});
// 		// };

// 		$scope.$on('$destroy', function cleanup() {
// 			releaseConnectorEvents();

// 			if (connectionId){
// 				channel.leave({connectionId:connectionId});
// 			}
// 		});

		
// 		$scope.getUser = function (userId) {
// 			if ($scope.me.id === userId){
// 				return $scope.me;
// 			}

// 			var selectedUsers = $scope.others.filter(function(item){ return item.id === userId;});
// 			if (selectedUsers && selectedUsers.length > 0)
// 			{
// 				return selectedUsers[0];
// 			}

// 			return null;
// 		};

// 		$scope.check = function(){console.log(this.inputTalk.message);};

// 		$scope.inputKeypress = function($event){
// 			if ($event.keyCode === 13) // Enter key pess
// 			{
// 				$scope.sendMessage();
// 			}
// 		};

// 		$scope.sendMessage = function(){
// 			if (!$scope.inputTalk.message){
// 				return;
// 			}
			
// 			if ($scope.inputTalk.message == "/clear"){
// 				$scope.inputTalk.message = '';
// 				channel.clearUser(function(res){
// 					if (res.err){
// 						alert(JSON.stringify(res.err));
// 						return;
// 					}
// 				});
// 				channel.clearTalkHistory(function(res){
// 					if (res.err){
// 						alert(JSON.stringify(res.err));
// 						return;
// 					}
// 				});
// 				return;
// 			}

// 			if ($scope.inputTalk.message == "/clear user"){
// 				$scope.inputTalk.message = '';
// 				channel.clearUser(function(res){
// 					if (res.err){
// 						alert(JSON.stringify(res.err));
// 						return;
// 					}
// 				});
// 				return;
// 			}

// 			if ($scope.inputTalk.message == "/clear history"){
// 				$scope.inputTalk.message = '';
// 				channel.clearTalkHistory(function(res){
// 					if (res.err){
// 						alert(JSON.stringify(res.err));
// 						return;
// 					}
// 				});
// 				return;
// 			}

// 			var data = {
// 				id:randomString(8),
// 				userId:$scope.me.id, 
// 				channelId:$scope.channelId, 
// 				message:$scope.inputTalk.message, 
// 				time:new Date()
// 			};

// 			var talk = addTalk(data);
// 			$scope.inputTalk.message = '';
// 			channel.addNewTalk(data, function(res){
// 				if (res.err){
// 					alert(JSON.stringify(res.err));
// 					return;
// 				}
// 				if (talk){
// 					$scope.$apply(function(){
// 						talk.id = res.result.id;
// 						talk.time = res.result.time;
// 					});
// 				}
				
// 			});
// 		};


// 		// var isCopiedShareUrlTimer = null;
// 		// $scope.copyShareUrlComplete = function(){
// 		// 	$scope.isCopiedShareUrl = true;

// 		// 	if (isCopiedShareUrlTimer){
// 		// 		clearTimeout(isCopiedShareUrlTimer);	
// 		// 	}				

// 		// 	isCopiedShareUrlTimer = setTimeout(function(){
// 		// 		$scope.$apply(function(){
// 		// 			$scope.isCopiedShareUrl = false;
// 		// 		});
// 		// 	}, 2000);
// 		// };
// 		var isSetNewNameTimer = null;			
// 		$scope.setNewName = function(){
// 			if ($scope.newName && ($scope.newName !== $scope.me.name)){
// 				$scope.changingUsername = true;					
// 				channel.updateUser(
// 					{
// 						channelId:$scope.channelId, 
// 						userId:$scope.me.id, 
// 						propertyName:'name', 
// 						data:$scope.newName
// 					}, function (res){
// 						if (!res.err){
// 							onUpdateUser(res.result);
// 						}
// 						$scope.$apply(function(){
// 							if (!res.err){
// 								$scope.isSettedNewName = true;
// 								if (isSetNewNameTimer) {clearTimeout(isSetNewNameTimer);}
// 								isSetNewNameTimer = setTimeout(function(){
// 									$scope.$apply(function(){$scope.isSettedNewName = false;})
// 								}, 2000);
// 							}

// 							$scope.changingUsername = false;
// 							$scope.newName = '';
// 						});
						
// 					});					
// 			}
// 		};

// 		$scope.openNewPopupWindow = function(){
// 			var url = encodeURI(window.location.protocol + '//' + window.location.host + '/p#/ch/' + $scope.channelId + '?userid=' + $scope.me.id);
// 			window.open(url, "_blank", "directories=no, location=no, menubar=no, status=no, titlebar=no, toolbar=no, scrollbars=no, resizable=yes, width=300, height=485");
// 		};

// 		function onNewTalk(talk){
// 			$scope.$apply(function(){
// 				addTalk(talk);					
// 			});
// 		}

// 		function onAddUser(user){
// 			$scope.$apply(function(){
// 				$scope.addUser(new TalkUser(user));
// 			});
// 		}

// 		function onRemoveUser(userId){
// 			$scope.$apply(function(){
// 				$scope.removeUser(userId);
// 			});	
// 		}

// 		function onUpdateUser(data){
// 			if (data.userId && data.propertyName){
// 				var user = $scope.getUser(data.userId);
// 				if (user){
// 					$scope.$apply(function(){
// 						user[data.propertyName] = data.data;

// 						if (data.propertyName === 'connections'){
// 							updateOnlineUser(user);
// 						}
// 					});
// 				}	
// 			}
// 		}

// 		function onReconnected(){
// 			joinChannel(true);
// 		}

// 		function addTalk(data){
// 			if (!(data.id) || _.any(talks, function (talk){return talk.id === data.id;})){
// 				return null;
// 			}

// 			var newTalk = new Talk(data);
// 			talks.push(newTalk);

// 			if (lastTalkGroup && lastTalkGroup.canAdd(newTalk)){
// 				lastTalkGroup.addTalk(newTalk);
// 			}
// 			else{
// 				var talkGroup = new TalkGroup(newTalk);
// 				$scope.talkGroups.push(talkGroup);
// 				lastTalkGroup = talkGroup;
// 			}

// 			return newTalk;
// 		}

// 		function joinChannel(isReconnected){
// 			channel.joinChannel(function(res){
// 				if (res.err){
// 					alert(JSON.stringify(res.err));
// 					return;
// 				}

// 				setConnectorEvents();					
// 				connectionId = res.result.connectionId;
// 				var users = res.result.users;
// 				var talks = res.result.talks;
				
// 				$scope.$apply(function(){
// 					if (_.isArray(users)){
// 						_.each(users, function (user){ $scope.addUser(new TalkUser(user)); });
// 					}

// 					if (_.isArray(talks)){
// 						_.each(talks, function (talk){ addTalk(talk); });
// 					}
// 				});
// 			});
// 		}

// 		function setConnectorEvents(){			
// 			// connector.addListener('reconnected', onReconnected);
// 			if (channel) {
// 				channel.on('onNewTalk', onNewTalk);
// 				channel.on('onAddUser', onAddUser);
// 				channel.on('onRemoveUser', onRemoveUser);
// 				channel.on('onUpdateUser', onUpdateUser);		
// 			}			
			
// 		}

// 		function releaseConnectorEvents(){				
// 			// connector.removeListener('reconnected', onReconnected);
// 			if (channel) {
// 				channel.off('onNewTalk', onNewTalk);
// 				channel.off('onAddUser', onAddUser);
// 				channel.off('onRemoveUser', onRemoveUser);
// 				channel.off('onUpdateUser', onUpdateUser);		
// 			}
// 			// connector.removeListener('statusChanged', serverStatusChanged);
// 		}

// 		function refreshWithUserId(userId){
// 			window.location = encodeURI(window.location.pathname + '#/ch/' + $scope.channelId + '?userid=' + userId);
// 		}

// 		$scope.getShareUrl = function(){
// 			return encodeURI(window.location.protocol + '//' + window.location.host + window.location.pathname + '#/ch/' + $scope.channelId);
// 		};

// 		var isCopiedShareUrlTimer = null;
// 		$scope.copyShareUrlComplete = function(){
// 			$scope.isCopiedShareUrl = true;

// 			if (isCopiedShareUrlTimer){
// 				clearTimeout(isCopiedShareUrlTimer);	
// 			}				

// 			isCopiedShareUrlTimer = setTimeout(function(){
// 				$scope.$apply(function(){
// 					$scope.isCopiedShareUrl = false;
// 				});
// 			}, 2000);
// 		};

// 		$scope.addUser = function (user) {
// 			if (!user || !(user instanceof TalkUser))
// 			{
// 				return;
// 			}

// 			var selectedUsers = $scope.others.filter(function(item){return item.id === user.id;});

// 			if (selectedUsers.length > 0){
// 				// 존재한다면;
// 				var selectedUser = selectedUsers[0];
// 				selectedUser.update(user);
// 			}
// 			else{
// 				// 같은 ID를 가진 놈이 없다면 추가하라.
// 				$scope.others.push(user);
// 			}

// 			updateOnlineUser(user);
// 		};

// 		$scope.removeUser = function (userId) {
// 			var user = $scope.getUser(userId);

// 			if (user)
// 			{
// 				$scope.others.splice($scope.others.indexOf(user), 1);

// 				var onlineUser = _.find($scope.onlineUsers, function(item){return item.id === user.id;});
// 				if (onlineUser){
// 					$scope.onlineUsers.splice($scope.onlineUsers.indexOf(onlineUser), 1);
// 				}
// 			}

// 			return user;
// 		};

// 		function updateOnlineUser(user){
// 			if (!user || !(user instanceof TalkUser) || user.id === $scope.me.id)
// 			{
// 				return;
// 			}

// 			var existUser = _.find($scope.onlineUsers, function(item){return item.id === user.id;});

// 			if (existUser){
// 				if (!user.isAlive()){
// 					//지우기
// 					$scope.onlineUsers.splice($scope.onlineUsers.indexOf(existUser), 1);
// 				}
// 			}
// 			else{
// 				if (user.isAlive()){
// 					//추가
// 					$scope.onlineUsers.push(user);
// 				}
// 			}
// 		}

// 		if(!$scope.$$phase) {
// 			$scope.$apply();
// 		}




// }]);