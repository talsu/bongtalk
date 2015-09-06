(function(){
	"use strict";

	this.Bongtalk = function (url) { return new BongtalkClient(Qufox(url)); };

	var BongtalkClient = (function(){
		function BongtalkClient (qufox){			
			this.qufox = qufox;
			this.token = null;
			this.tokenExpire = null;
		}

		BongtalkClient.prototype.getAllChannel = function (callback) {
			$.ajax({
				type: "GET",
				url: "getAllChannel",						
				dataType: "json",
				success: function (response) { 
					if (isFunction(callback)) callback(response);
				},
				error: function (err) { 
					if (isFunction(callback)) callback({err:err});
				},
				complete: function () { }
			});
		};

		// BongtalkClient.prototype.addUser = function (userName, callback) {
		// 	ajaxPost('addUser', {userName:userName}, callback);
		// };
 
 	// 	BongtalkClient.prototype.getUser = function (userId, callback) {
		// 	ajaxPost('getUser', {userId:userId}, callback);
		// };

		// BongtalkClient.prototype.setUser = function (userId, property, value, callback) {
		// 	ajaxPost('setUser', {userId:userId, property:property, value:value}, callback);
		// };

		BongtalkClient.prototype.joinChannel = function (channelId, userId, userName) {
			return new Channel(channelId, userId, userName, this.qufox);
		};

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

		BongtalkClient.prototype.signUp = function (userId, password, callback) {
			ajaxPost('api/signUp', {userId:userId, password:password}, callback);
		};


		// Require Auth API
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
				}
				if (isFunction(callback)) callback(res);
			});
		};

		BongtalkClient.prototype.getUser = function (userId, callback) {
			ajaxAuthGet('api/users/' + userId, this.token, {}, callback);
		};

		

		// Auth token
		BongtalkClient.prototype.setAuthToken = function (authToken) {
			this.token = authToken.token;
			this.tokenExpire = authToken.expire;
		};		

		_.extend(BongtalkClient.prototype, EventEmitter.prototype);
		
		return BongtalkClient;
	})();


	var Channel = (function(){
		function Channel (channelId, userId, userName, qufox) {
			var self = this;
			self.channelId = channelId;
			self.userId = userId;
			self.userName = userName;
			self.qufox = qufox;

			self.receiveMessageCallback = null;

			qufox.join("channel-" + channelId, function (data) {
				self.emit(data.type, data.data);
			});
		}

		Channel.prototype.leave = function (connectionId) {
			ajaxPost('leaveChannel', {connectionId:connectionId});
		};

		Channel.prototype.getUser = function (userId, callback) {			
			ajaxPost('getUserFromChannel', {channelId:this.channelId, userId:userId}, callback);
		};

		Channel.prototype.getUsers = function (callback) {			
			ajaxPost('getUsersFromChannel', {channelId:this.channelId}, callback);
		};

		Channel.prototype.addUser = function (userId, userName, callback) {
			var self = this;
			var data = {userId:userId, userName:userName, channelId:self.channelId};
			ajaxAndSend('addUserToChannel', data, self.channelId, self.qufox, 'onAddUser', callback);
		};

		Channel.prototype.clearUser = function (callback) {
			ajaxPost('clearUser', {channelId:this.channelId}, callback);
		};

		Channel.prototype.clearTalkHistory = function (callback) {
			ajaxPost('clearTalkHistory', {channelId:this.channelId}, callback);
		};

		Channel.prototype.getTalkHistory = function (callback) {
			ajaxPost('getTalkHistory', {channelId:this.channelId}, callback);
		};

		Channel.prototype.addNewTalk = function (data, callback) {
			var self = this;
			data.channelId = this.channelId;
			ajaxAndSend('addNewTalk', data, self.channelId, self.qufox, 'onNewTalk', callback);			
		};

		Channel.prototype.updateUser = function (data, callback) {
			var self = this;
			data.channelId = this.channelId;
			ajaxAndSend('updateUser', data, self.channelId, self.qufox, 'onUpdateUser', callback);
		};

		Channel.prototype.joinChannel = function (callback) {			
			ajaxPost('joinChannel', {channelId:this.channelId}, callback);
		};

		_.extend(Channel.prototype, EventEmitter.prototype);

		return Channel;
	})();


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

	function ajaxAuthGet(url, token, data, callback)
	{
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

	function ajaxAuthPost(url, token, data, callback)
	{
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

	function ajaxAuthPut(url, token, data, callback)
	{
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

	function ajaxGet(url, data, callback)
	{
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

	function ajaxPost(url, data, callback)
	{
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


}.call(this));