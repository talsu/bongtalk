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