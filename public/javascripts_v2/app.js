'use strict';

/* App Module */

angular.module('bongtalkApp', [
	'ngRoute',
	'ngDialog',
	'luegg.directives',
	'bongtalk.controllers'
])
.config(['$routeProvider',
	function($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials_v2/main.html', controller: 'MainController' })
			.when('/login', { templateUrl: 'partials_v2/loginDialog.html', controller: 'LoginDialogController' })
			.when('/signin', { templateUrl: 'partials_v2/signInDialog.html', controller: 'SignInDialogController' })
			.when('/signup', { templateUrl: 'partials_v2/signUpDialog.html', controller: 'SignUpDialogController' })
			.otherwise({ redirectTo: '/'});
	}]);


angular.module('bongtalkSessionApp', [
	'ngRoute',
	'ngDialog',
	'luegg.directives',
	'bongtalk.controllers'
])
.config(['$routeProvider',
	function($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials_v2/session.html', controller: 'SessionController' })
			.otherwise({ redirectTo: '/'});
	}]);