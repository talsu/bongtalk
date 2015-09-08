'use strict';

/* App Module */

angular.module('bongtalkApp', [
	'ngRoute',
	'ngCookies',
	'ngAnimate',
	'ngDialog',
	'luegg.directives',
	'bongtalk.controllers'
])
.config(['$routeProvider',
	function ($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials_v2/boot.html', controller: 'BootController' })
			.when('/main', { templateUrl: 'partials_v2/main.html', controller: 'MainController' })
			.when('/main/:left', { templateUrl: 'partials_v2/main.html', controller: 'MainController' })
			.when('/main/:left/:right', { templateUrl: 'partials_v2/main.html', controller: 'MainController' })
			.when('/main/:left/:right/:param', { templateUrl: 'partials_v2/main.html', controller: 'MainController' })
			.when('/login', { templateUrl: 'partials_v2/loginDialog.html', controller: 'LoginDialogController' })
			.when('/signout', { templateUrl: 'partials_v2/boot.html', controller: 'SignOutController' })
			.when('/signin', { templateUrl: 'partials_v2/signInDialog.html', controller: 'SignInDialogController' })
			.when('/signup', { templateUrl: 'partials_v2/signUpDialog.html', controller: 'SignUpDialogController' })
			.when('/test', { templateUrl: 'partials_v2/test.html', controller: 'TestController' })
			.otherwise({ redirectTo: '/'});
	}])
.run(['$window', '$rootScope', 
	function ($window ,  $rootScope) {
		$rootScope.goBack = function(){
			$window.history.back();
		}
	}]);


angular.module('bongtalkSessionApp', [
	'ngRoute',
	'ngDialog',
	'luegg.directives',
	'bongtalk.controllers'
])
.config(['$routeProvider',
	function ($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials_v2/session.html', controller: 'SessionController' })
			.otherwise({ redirectTo: '/'});
	}]);