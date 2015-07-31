(function(){
	"use strict";

	this.Bongtalk = function (url) { return new BongtalkClient(url, Qufox()); };

	var BongtalkClient = (function(){
		function BongtalkClient (url, qufox){
			this.url = url;
			this.qufox = qufox;
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

		BongtalkClient.prototype.joinChannel = function (channelId, userId, userName) {
			return new Channel(channelId, userId, userName, this.qufox);
		};

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

		Channel.prototype.joinChannel = function (userId, callback) {			
			ajaxPost('joinChannel', {channelId:this.channelId, userId:userId}, callback);
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