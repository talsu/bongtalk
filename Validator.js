
module.exports = (function() {
	function Validator() { }

	Validator.prototype.validateUserName = function (userName) {
		var result = {
			status:'',
			comment:'',
			ok:false,
		}

		if (!userName) {
			result.status = '';
			result.comment = '';
		} else if (userName.length < 2) {
			result.status = 'error';
			result.comment = 'Username is too short.';
		} else if (userName.length > 20) {
			result.status = 'error';
			result.comment = 'Username is too long.';
		} else if (/\s/g.test(userName)){
			result.status = 'error';
			result.comment = 'Username has white space.';
		} else {
			result.status = 'success';
			result.comment = '';
			result.ok = true;
		}

		return result;
	};

	Validator.prototype.validateUserId = function (userId) {
		var result = {
			status:'',
			comment:'',
			ok:false,
		}

		if (!userId) {
			result.status = '';
			result.comment = '';
		} else if (userId.length < 4) {
			result.status = 'error';
			result.comment = 'User ID is too short.';
		} else if (userId.length > 20) {
			result.status = 'error';
			result.comment = 'User ID is too long.';
		} else if (/\s/g.test(userId)){
			result.status = 'error';
			result.comment = 'User ID has white space.';
		} else {
			result.status = 'success';
			result.comment = '';
			result.ok = true;
		}

		return result;
	};

	Validator.prototype.validatePassword = function (password) {
		var result = {
			status:'',
			comment:'',
			ok:false,
		}

		if (!password) {
			result.status = '';
			result.comment = '';
		} else if (password.length < 4) {
			result.status = 'error';
			result.comment = 'Password is too short.';
		} else if (password.length > 20) {
			result.status = 'error';
			result.comment = 'Password is too long.';
		} else if (/\s/g.test(password)){
			result.status = 'error';
			result.comment = 'Password Has white space.';
		} else {
			result.status = 'success';
			result.comment = '';
			result.ok = true;
		}

		return result;
	};

	Validator.prototype.validateSessionName = function (sessionName) {
		var result = {
			status:'',
			comment:'',
			ok:false,
		}

		if (!sessionName) {
			result.status = 'error';
			result.comment = 'Session name is empty.';
		} else if (sessionName.length < 2) {
			result.status = 'error';
			result.comment = 'Session name is too short.';
		} else if (sessionName.length > 20) {
			result.status = 'error';
			result.comment = 'Session name is too long.';
		} else {
			result.status = 'success';
			result.comment = '';
			result.ok = true;
		}

		return result;
	};

	Validator.prototype.validateSessionType = function (sessionType, users) {
		var result = {
			status:'',
			comment:'',
			ok:false,
		}

		if (!sessionType) {
			result.status = 'error';
			result.comment = 'Session type is empty.';
		} else if (!Array.isArray(users)) {
			result.status = 'error';
			result.comment = 'users is not Array type.';
		} else if (['public', 'group', 'personal'].indexOf(sessionType) == -1){
			result.status = 'error';
			result.comment = 'Invalid session type : ' + sessionType;
		} else if (sessionType == 'public' && users.length == 0){
			result.status = 'error';
			result.comment = 'public session need user.';
		} else if (sessionType == 'group' && users.length == 0){
			result.status = 'error';
			result.comment = 'group session need user.';
		} else if (sessionType == 'personal' && (users.length != 2 || users[0] == users[1])){
			result.status = 'error';
			result.comment = 'personal session need two user.';
		} else {
			result.status = 'success';
			result.comment = '';
			result.ok = true;
		}

		return result;
	};

	return Validator;
})();