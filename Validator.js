
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

	return Validator;
})();