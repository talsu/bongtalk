(function(){
	"use strict";

	this.Bongtalk = function (url) { return new BongtalkClient(Qufox(url)); };

	var BongtalkClient = (function(){
		function BongtalkClient (qufox){			
			this.qufox = qufox;
			this.token = null;
			this.tokenExpire = null;
			this.privateEventEmitter = new EventEmitter();
			this.sessionEventEmitter = new EventEmitter();
			this.user = null;
			this.signInReadyCallback = [];
		}

		// BongtalkClient.prototype.getAllChannel = function (callback) {
		// 	$.ajax({
		// 		type: "GET",
		// 		url: "getAllChannel",						
		// 		dataType: "json",
		// 		success: function (response) { 
		// 			if (isFunction(callback)) callback(response);
		// 		},
		// 		error: function (err) { 
		// 			if (isFunction(callback)) callback({err:err});
		// 		},
		// 		complete: function () { }
		// 	});
		// };

		// BongtalkClient.prototype.addUser = function (userName, callback) {
		// 	ajaxPost('addUser', {userName:userName}, callback);
		// };
 
 	// 	BongtalkClient.prototype.getUser = function (userId, callback) {
		// 	ajaxPost('getUser', {userId:userId}, callback);
		// };

		// BongtalkClient.prototype.setUser = function (userId, property, value, callback) {
		// 	ajaxPost('setUser', {userId:userId, property:property, value:value}, callback);
		// };
		
		BongtalkClient.prototype.on = function (eventName, callback) {
			this.privateEventEmitter.on(eventName, callback);
		};

		BongtalkClient.prototype.off = function (eventName, callback) {
			this.privateEventEmitter.off(eventName, callback);
		};

		BongtalkClient.prototype.emit = function (name, object) {			
			this.emitToUser(this.user.id, name, object);
		};

		BongtalkClient.prototype.emitToUser = function (userId, name, object) {
			var self = this;
			self.qufox.send('private:' + userId, {name:name, object:object}, function (res){
				if (self.user.id == userId) {
					self.privateEventEmitter.emit(name, object);	
				}
			});
		};

		BongtalkClient.prototype.startSync = function (){
			var self = this;
			if (self.user && self.user.id){
				self.on('setMyInfo', function (data) {
					if (data) {
							for (var property in data) {
							self.user[property] = data[property];
						}	
					}
				});

				self.on('joinSession', function (sessionId){
					if (self.user.sessions.indexOf(sessionId) == -1){
						self.user.sessions.push(sessionId);
					}
				});

				self.on('leaveSession', function (sessionId){
					var index = self.user.sessions.indexOf(sessionId);
					if (index > -1){
						self.user.sessions.splice(index, 1);
					}
				});

				// listen private session
				self.qufox.join('private:' + self.user.id, function (data){
					if (data.name && data.object){
						self.privateEventEmitter.emit(data.name, data.object);	
					}
				});
			}
		};

		BongtalkClient.prototype.stopSync = function (){
			var self = this;
			if (self.user && self.user.id) {
				self.qufox.leave('private:' + self.user.id);
			}

			self.privateEventEmitter.removeAllListeners();
		};

		// BongtalkClient.prototype.joinChannel = function (channelId, userId, userName) {
		// 	return new Channel(channelId, userId, userName, this.qufox);
		// };

		// API
		BongtalkClient.prototype.checkUserExist = function (userId, callback) {
			ajaxGet('api/checkUserExist', {userId:userId}, callback);
		};

		BongtalkClient.prototype.signIn = function (userId, password, callback) {
			var self = this;
			ajaxPost('api/signIn', {userId:userId, password:password}, function (res) {
				if (res && !res.err && res.result){
					self.token = res.result.token;
					self.tokenExpire = res.result.tokenExpire;
					self.user = res.result.user;
				}
				if (isFunction(callback)) callback(res);
			});
		};

		BongtalkClient.prototype.signInByGuest = function (userName, callback) {
			var self = this;
			ajaxPost('api/signInByGuest', {userName:userName}, function (res) {
				if (res && !res.err && res.result){
					self.token = res.result.token;
					self.tokenExpire = res.result.tokenExpire;
					self.user = res.result.user;
				}
				if (isFunction(callback)) callback(res);
			});
		};

		BongtalkClient.prototype.signOut = function () {
			var self = this;
		};

		BongtalkClient.prototype.signUp = function (userId, password, callback) {
			ajaxPost('api/signUp', {userId:userId, password:password}, callback);
		};

		BongtalkClient.prototype.signInRecover = function (authToken, callback) {
			var self = this;
			self.setAuthToken(authToken);
			self.getMyInfo(function (res) {
				callback(res);

				if (self.signInReadyCallback.length > 0){
					_.each(self.signInReadyCallback, function (readyCallback){
						readyCallback(self.user);
					});	
				}
			});
		};

		BongtalkClient.prototype.signInReady = function (callback) {
			if (this.user) callback(this.user);
			else this.signInReadyCallback.push(callback);
		};

		// Auth token
		BongtalkClient.prototype.setAuthToken = function (authToken) {
			this.token = authToken.token;
			this.tokenExpire = authToken.expire;
		};


		// Require Auth API
		// User
		BongtalkClient.prototype.refreshToken = function(callback) {
			var self = this;
			ajaxAuthGet('api/refreshToken', this.token, {}, function (res) {
				if (res && !res.err && res.result){
					self.token = res.result.token;
					self.tokenExpire = res.result.tokenExpire;
					self.user = res.result.user;
				}
				if (isFunction(callback)) callback(res);
			});
		};

		BongtalkClient.prototype.getMyInfo = function (callback) {
			var self = this;
			ajaxAuthGet('api/user', this.token, {}, function (res) {
				if (res && !res.err && res.result){
					self.user = res.result;
				}
				if (isFunction(callback)) callback(res);
			});
		};

		BongtalkClient.prototype.setMyInfo = function (data, callback) {
			var self = this;
			ajaxAuthPut('api/users/' + this.user.id, this.token, data, function (res){
				if (res && !res.err && res.result && res.result.ok && self.user && data){
					for (var property in data) {
						self.user[property] = data[property];
					}

					self.emit('setMyInfo', data);
				}
				if (isFunction(callback)) callback(res);
			});
		};

		BongtalkClient.prototype.changePassword = function (currentPassword, newPassword, callback) {
			ajaxAuthPost('api/changePassword', this.token, {currentPassword:currentPassword, newPassword:newPassword}, callback);
		};

		BongtalkClient.prototype.getUser = function (userId, callback) {
			ajaxAuthGet('api/users/' + userId, this.token, {}, callback);
		};

		// Session
		BongtalkClient.prototype.addSession = function (name, type, users, callback) {
			var self = this;
			var sessionUsers = [self.user.id];
			if (isString(users)) {
				sessionUsers.push(users);
			} else if (isArray(users)) {
				_.each(users, function (userId) {
					if (!_.contains(sessionUsers, userId)) sessionUsers.push(userId);
				});
			}
			ajaxAuthPost('api/sessions', this.token, {name:name, type:type, users:sessionUsers}, function (res){
				if (!res.err) {
					if (self.user.sessions.indexOf(res.result._id) == -1) {
						self.user.sessions.push(res.result._id);
					}
					_.each(res.result.users, function (userId) {
						self.emitToUser(userId, 'joinSession', res.result._id);
					});					
				}
				callback(res);
			});
		};

		BongtalkClient.prototype.getSession = function (sessionId, callback) {
			var self = this;
			ajaxAuthGet('api/sessions/' + sessionId, this.token, {}, function (res) {
				if (!res.err && self.user.sessions.indexOf(sessionId) == -1){
					self.joinSession(sessionId, function(){});
				}
				callback(res);
			});
		};
		
		BongtalkClient.prototype.getPublicSessions = function (callback) {
			ajaxAuthGet('api/sessions/type/public', this.token, {}, callback);
		};
		
		BongtalkClient.prototype.joinSession = function (sessionId, callback) {
			var self = this;
			ajaxAuthPost('api/sessions/'+sessionId+'/users', this.token, {}, function (res){
				if (!res.err){
					self.emit('joinSession', sessionId);
				}
				callback(res);
			});
		};

		BongtalkClient.prototype.leaveSession = function (sessionId, callback) {
			var self = this;
			ajaxAuthDelete('api/sessions/'+sessionId+'/users', this.token, {}, function (res){
				if (!res.err){
					self.emit('leaveSession', sessionId);
				}
				callback(res);
			});
		};

		BongtalkClient.prototype.getUserSessions = function (callback) {
			ajaxAuthGet('api/users/' + this.user.id + '/sessions', this.token, {}, callback);
		};

		// Telegram
		BongtalkClient.prototype.addTelegram = function (sessionId, type, subType, data, callback){
			var self = this;
			ajaxAuthPost('api/sessions/'+sessionId+'/telegrams', this.token, 
				{userName:self.user.name, type:type, subType:subType, data:data}, function (res){
					if (res.err || !res.result){
						callback(res)
					}
					else{
						self.qufox.send('session:' + sessionId, res.result, function (){
							callback(res);
						});
					}					
				});
		};

		BongtalkClient.prototype.getTelegrams = function (sessionId, ltTime, count, callback){
			ajaxAuthGet('api/sessions/'+sessionId+'/telegrams', this.token, {ltTime:ltTime, count:count}, callback);
		};		

		BongtalkClient.prototype.onTelegram = function (sessionId, callback) {
			this.qufox.on('session:' + sessionId, callback);
		};

		BongtalkClient.prototype.offTelegram = function (sessionId, callback) {
			this.qufox.off('session:' + sessionId, callback);
		};

		// for Admin (only working with admin account)
		BongtalkClient.prototype.removeUser = function (userId, callback) {
			ajaxAuthDelete('api/admin/users/' + userId, this.token, {}, callback);
		};

		BongtalkClient.prototype.removeSession = function (sessionId, callback) {
			var self = this;
			ajaxAuthGet('api/admin/sessions/' + sessionId, self.token, {}, function (res){
				if (res.err) { callback(res); return; }
				var users = res.result.users;
				ajaxAuthDelete('api/admin/sessions/' + sessionId, self.token, {}, function (res){
					if (res.err) { callback(res); return; }
					if (isArray(users)){
						_.each(users, function (userId){
							self.emitToUser(userId, 'leaveSession', sessionId);
						});
					}
					callback(res);
				});	
			});
		};

		BongtalkClient.prototype.getAllUser = function (callback) {
			ajaxAuthGet('api/admin/users', this.token, {}, callback);
		};

		BongtalkClient.prototype.getAllSession = function (callback) {
			ajaxAuthGet('api/admin/sessions', this.token, {}, callback);
		};

		return BongtalkClient;
	})();


	// var Channel = (function(){
	// 	function Channel (channelId, userId, userName, qufox) {
	// 		var self = this;
	// 		self.channelId = channelId;
	// 		self.userId = userId;
	// 		self.userName = userName;
	// 		self.qufox = qufox;

	// 		self.receiveMessageCallback = null;

	// 		qufox.join("channel-" + channelId, function (data) {
	// 			self.emit(data.type, data.data);
	// 		});
	// 	}

	// 	Channel.prototype.leave = function (connectionId) {
	// 		ajaxPost('leaveChannel', {connectionId:connectionId});
	// 	};

	// 	Channel.prototype.getUser = function (userId, callback) {			
	// 		ajaxPost('getUserFromChannel', {channelId:this.channelId, userId:userId}, callback);
	// 	};

	// 	Channel.prototype.getUsers = function (callback) {			
	// 		ajaxPost('getUsersFromChannel', {channelId:this.channelId}, callback);
	// 	};

	// 	Channel.prototype.addUser = function (userId, userName, callback) {
	// 		var self = this;
	// 		var data = {userId:userId, userName:userName, channelId:self.channelId};
	// 		ajaxAndSend('addUserToChannel', data, self.channelId, self.qufox, 'onAddUser', callback);
	// 	};

	// 	Channel.prototype.clearUser = function (callback) {
	// 		ajaxPost('clearUser', {channelId:this.channelId}, callback);
	// 	};

	// 	Channel.prototype.clearTalkHistory = function (callback) {
	// 		ajaxPost('clearTalkHistory', {channelId:this.channelId}, callback);
	// 	};

	// 	Channel.prototype.getTalkHistory = function (callback) {
	// 		ajaxPost('getTalkHistory', {channelId:this.channelId}, callback);
	// 	};

	// 	Channel.prototype.addNewTalk = function (data, callback) {
	// 		var self = this;
	// 		data.channelId = this.channelId;
	// 		ajaxAndSend('addNewTalk', data, self.channelId, self.qufox, 'onNewTalk', callback);			
	// 	};

	// 	Channel.prototype.updateUser = function (data, callback) {
	// 		var self = this;
	// 		data.channelId = this.channelId;
	// 		ajaxAndSend('updateUser', data, self.channelId, self.qufox, 'onUpdateUser', callback);
	// 	};

	// 	Channel.prototype.joinChannel = function (callback) {			
	// 		ajaxPost('joinChannel', {channelId:this.channelId}, callback);
	// 	};

	// 	_.extend(Channel.prototype, EventEmitter.prototype);

	// 	return Channel;
	// })();


	function ajaxAndSend(url, data, channelId, qufox, sendType, callback){
		ajaxPost(url, data, 
			function (res) {
				qufox.send("channel-" + channelId, {type:sendType,data:res.result}, function (sendResult){
					if (sendResult.err) res.err = sendResult.err;
					if (isFunction(callback)) callback(res);
				});
			}
		);
	}

	function ajaxAuthGet(url, token, data, callback) {
		$.ajax({
			type: "GET",
			headers: {'x-access-token': token},
			url: url,
			data: data,
			dataType: "json",
			success: function (response) { 
				if (isFunction(callback)) callback(response);
			},
			error: function (err) { 
				if (isFunction(callback)) callback({err:err});
			},
			complete: function () { }
		});
	}

	function ajaxAuthPost(url, token, data, callback) {
		$.ajax({
			type: "POST",
			headers: {'x-access-token': token},
			url: url,
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			success: function (response) { 
				if (isFunction(callback)) callback(response);
			},
			error: function (err) { 
				if (isFunction(callback)) callback({err:err});
			},
			complete: function () { }
		});
	}

	function ajaxAuthPut(url, token, data, callback) {
		$.ajax({
			type: "PUT",
			headers: {'x-access-token': token},
			url: url,
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			success: function (response) { 
				if (isFunction(callback)) callback(response);
			},
			error: function (err) { 
				if (isFunction(callback)) callback({err:err});
			},
			complete: function () { }
		});
	}

	function ajaxAuthDelete(url, token, data, callback) {
		$.ajax({
			type: "DELETE",
			headers: {'x-access-token': token},
			url: url,
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			success: function (response) { 
				if (isFunction(callback)) callback(response);
			},
			error: function (err) { 
				if (isFunction(callback)) callback({err:err});
			},
			complete: function () { }
		});
	}

	function ajaxGet(url, data, callback) {
		$.ajax({
			type: "GET",
			url: url,
			data: data,
			dataType: "json",
			success: function (response) { 
				if (isFunction(callback)) callback(response);
			},
			error: function (err) { 
				if (isFunction(callback)) callback({err:err});
			},
			complete: function () { }
		});
	}

	function ajaxPost(url, data, callback) {
		$.ajax({
			type: "POST",
			url: url,
			data: JSON.stringify(data),
			contentType: "application/json; charset=utf-8",
			dataType: "json",
			success: function (response) { 
				if (isFunction(callback)) callback(response);
			},
			error: function (err) { 
				if (isFunction(callback)) callback({err:err});
			},
			complete: function () { }
		});
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

	function isFunction(object) {
		return !!(object && object.constructor && object.call && object.apply);
	}

	function isArray(object) {
		return _.isArray(object);
	}

	function isString(object) {
		return _.isString(object);
	}


}.call(this));